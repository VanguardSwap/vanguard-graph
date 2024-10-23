/* eslint-disable prefer-const */
import { BigDecimal, BigInt, store } from "@graphprotocol/graph-ts";

import {
  Bundle, Burn as BurnEvent,
  Mint as MintEvent, Pool,
  Swap as SwapEvent, Token,
  Transaction, Factory
} from "../generated/schema";

import {
  Burn, Mint,
  Swap, Sync, Transfer
} from "../generated/templates/ClassicPool/ClassicPool";

import {
  updatePairDayData, updatePairHourData,
  updateTokenDayData, updateVanguardDayData
} from "./dayUpdates";

import {
  ADDRESS_ZERO, BI_18,
  convertTokenToDecimal, createUser,
  FACTORY_ADDRESS, ONE_BI, updateUserPosition, ZERO_BD
} from "./helpers";

import {
  findEthPerToken, getEthPriceInUSD,
  getTrackedLiquidityUSD, getTrackedVolumeUSD
} from "./pricing";

function isCompleteMint(mintId: string): boolean {
  let mint = MintEvent.load(mintId);
  if (mint) return mint.sender !== null; // sufficient checks
  return false;
}

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  if (
    event.params.to.toHexString() == ADDRESS_ZERO &&
    event.params.value.equals(BigInt.fromI32(1000))
  ) {
    return;
  }

  let transactionHash = event.transaction.hash.toHexString();

  // user stats
  let from = event.params.from;
  createUser(from);
  let to = event.params.to;
  createUser(to);

  // get pair and load contract
  let pair = Pool.load(event.address.toHexString());
  if (!pair) return;

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.value, BI_18);

  // get or create transaction
  let transaction = Transaction.load(transactionHash);
  if (transaction === null) {
    transaction = new Transaction(transactionHash);
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.burns = [];
    transaction.swaps = [];
  }

  // mints
  let mints = transaction.mints;
  // part of the erc-20 standard (which is also the pool), whenever you mint new tokens, the from address is 0x0..0
  // the pool is also the erc-20 that gets minted and transferred around
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    pair.save();

    // create new mint if no mints so far or if last one is done already
    // transfers and mints come in pairs, but there could be a case where that doesn't happen and it might break
    // this is to make sure all the mints are under the same transaction
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash
          .toHexString()
          .concat("-")
          .concat(BigInt.fromI32(mints.length).toString())
      );

      mint.transaction = transaction.id;
      mint.pool = pair.id;
      mint.to = to;
      mint.liquidity = value;
      mint.timestamp = transaction.timestamp;
      mint.transaction = transaction.id;
      mint.save();

      // update mints in transaction
      transaction.mints = mints.concat([mint.id]);

      // save entities
      transaction.save();
    }
  }

  // case where direct send first on ETH withdrawals
  // for every burn event, there is a transfer first from the LP to the pool (erc-20)
  // when you LP, you get an ERC-20 token which is the accounting token of the LP position
  // the thing that's actually getting transferred is the LP account token
  if (event.params.to.toHexString() == pair.id) {
    let burns = transaction.burns;
    let burn = new BurnEvent(
      event.transaction.hash
        .toHexString()
        .concat("-")
        .concat(BigInt.fromI32(burns.length).toString())
    );

    burn.transaction = transaction.id;
    burn.pool = pair.id;
    burn.liquidity = value;
    burn.timestamp = transaction.timestamp;
    burn.to = event.params.to;
    burn.sender = event.params.from;
    burn.needsComplete = true;
    burn.transaction = transaction.id;
    burn.save();

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id);
    transaction.burns = burns;
    transaction.save();
  }

  // burn
  // there's two transfers for the LP token,
  // first its going to move from the LP back to the pool, and then it will go from the pool to the zero address
  if (
    event.params.to.toHexString() == ADDRESS_ZERO &&
    event.params.from.toHexString() == pair.id
  ) {
    pair.totalSupply = pair.totalSupply.minus(value);
    pair.save();

    // this is a new instance of a logical burn
    let burns = transaction.burns;
    let burn: BurnEvent;
    // this block creates the burn or gets the reference to it if it already exists
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1]);
      if (!currentBurn) return;
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent;
      } else {
        burn = new BurnEvent(
          event.transaction.hash
            .toHexString()
            .concat("-")
            .concat(BigInt.fromI32(burns.length).toString())
        );

        burn.transaction = transaction.id;
        burn.needsComplete = false;
        burn.pool = pair.id;
        burn.liquidity = value;
        burn.transaction = transaction.id;
        burn.timestamp = transaction.timestamp;
      }
    } else {
      burn = new BurnEvent(
        event.transaction.hash
          .toHexString()
          .concat("-")
          .concat(BigInt.fromI32(burns.length).toString())
      );

      burn.transaction = transaction.id;
      burn.needsComplete = false;
      burn.pool = pair.id;
      burn.liquidity = value;
      burn.transaction = transaction.id;
      burn.timestamp = transaction.timestamp;
    }

    // if this logical burn included a fee mint, account for this
    // what is a fee mint?
    // how are fees collected on v2?
    // when you're an LP in v2, you're earning fees in terms of LP tokens, so when you go to burn your position, burn and collect fees at the same time
    // protocol is sending the LP something and we think it's a mint when it's not and it's really fees
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1]);
      if (!mint) return;

      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      store.remove("Mint", mints[mints.length - 1]);
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop();
      transaction.mints = mints;
      transaction.save();
    }
    // when you collect fees or burn liquidity what are the events that get triggered
    // not sure why this replaced the last one instead of updating
    burn.save();
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id;
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id);
    }
    transaction.burns = burns;
    transaction.save();
  }

  transaction.save();
}

export function handleSync(event: Sync): void {
  let pair = Pool.load(event.address.toHexString());
  if (!pair) return;

  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  if (!token0 || !token1) return;

  let factory = Factory.load(FACTORY_ADDRESS);

  // reset factory liquidity by subtracting only tracked liquidity
  if (factory) {
    factory.totalLiquidityETH = factory.totalLiquidityETH.minus(
      pair.trackedReserveETH as BigDecimal
    );
  }

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1);
  else pair.token0Price = ZERO_BD;
  if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0);
  else pair.token1Price = ZERO_BD;

  pair.save();

  // update ETH price now that reserves could have changed
  let bundle = Bundle.load("1");
  if (!bundle) return;
  bundle.ethPrice = getEthPriceInUSD();
  bundle.save();

  token0.derivedETH = findEthPerToken(token0 as Token);
  token1.derivedETH = findEthPerToken(token1 as Token);
  token0.save();
  token1.save();

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityETH: BigDecimal;
  if (bundle.ethPrice.notEqual(ZERO_BD)) {
    trackedLiquidityETH = getTrackedLiquidityUSD(
      pair.reserve0,
      token0 as Token,
      pair.reserve1,
      token1 as Token
    ).div(bundle.ethPrice);
  } else {
    trackedLiquidityETH = ZERO_BD;
  }

  // use derived amounts within pair
  pair.trackedReserveETH = trackedLiquidityETH;

  pair.reserveETH = pair.reserve0
    .times(token0.derivedETH as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedETH as BigDecimal));

  pair.reserveUSD = pair.reserveETH.times(bundle.ethPrice);

  // use tracked amounts globally
  if (factory) {
    factory.totalLiquidityETH = factory.totalLiquidityETH.plus(trackedLiquidityETH);
    factory.totalLiquidityUSD = factory.totalLiquidityETH.times(bundle.ethPrice);
    factory.save();
  }

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1);

  // save entities
  pair.save();
  token0.save();
  token1.save();
}

export function handleMint(event: Mint): void {
  // loaded from a previous handler creating this transaction
  // transfer event is emitted first and mint event is emitted afterwards, good to confirm with a protocol eng
  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (!transaction) return;

  let mints = transaction.mints;
  let mint = MintEvent.load(mints[mints.length - 1]);

  if (!mint) return;

  let pair = Pool.load(event.address.toHexString());
  if (!pair) return;

  let factory = Factory.load(FACTORY_ADDRESS);

  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  if (!token0 || !token1) return;

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(
    event.params.amount0,
    token0.decimals
  );

  let token1Amount = convertTokenToDecimal(
    event.params.amount1,
    token1.decimals
  );

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // get new amounts of USD and ETH for tracking
  let bundle = Bundle.load("1");
  let bundleEthPrice = ZERO_BD;
  if (bundle) {
    bundleEthPrice = bundle.ethPrice;
  }

  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(bundleEthPrice);

  // update txn counts
  pair.txCount = pair.txCount.plus(ONE_BI);

  if (factory) {
    factory.txCount = factory.txCount.plus(ONE_BI);
    factory.save();
  }

  // save entities
  token0.save();
  token1.save();
  pair.save();

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount as BigDecimal;
  mint.amount1 = token1Amount as BigDecimal;
  mint.logIndex = event.logIndex;
  mint.amountUSD = amountTotalUSD as BigDecimal;
  mint.save();

  updateUserPosition(
    event.params.to, event.address,
    event.params.liquidity, true
  );

  // update day entities
  updatePairDayData(event);
  updatePairHourData(event);
  updateVanguardDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString());

  // safety check
  if (!transaction) return;

  let burns = transaction.burns;
  let burn = BurnEvent.load(burns[burns.length - 1]);

  if (!burn) return;

  let pair = Pool.load(event.address.toHexString());
  let factory = Factory.load(FACTORY_ADDRESS);
  if (!pair || !factory) return;

  //update token info
  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  if (!token0 || !token1) return;

  let token0Amount = convertTokenToDecimal(
    event.params.amount0,
    token0.decimals
  );

  let token1Amount = convertTokenToDecimal(
    event.params.amount1,
    token1.decimals
  );

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // get new amounts of USD and ETH for tracking
  let bundle = Bundle.load("1");
  let bundleEthPrice = ZERO_BD;
  if (bundle) {
    bundleEthPrice = bundle.ethPrice;
  }

  let amountTotalUSD = token1.derivedETH
    .times(token1Amount)
    .plus(token0.derivedETH.times(token0Amount))
    .times(bundleEthPrice);

  // update txn counts
  factory.txCount = factory.txCount.plus(ONE_BI);
  pair.txCount = pair.txCount.plus(ONE_BI);

  // update global counter and save
  token0.save();
  token1.save();
  pair.save();
  factory.save();

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal;
  burn.amount1 = token1Amount as BigDecimal;
  // burn.to = event.params.to
  burn.logIndex = event.logIndex;
  burn.amountUSD = amountTotalUSD as BigDecimal;
  burn.save();

  updateUserPosition(
    event.params.to, event.address,
    event.params.liquidity, false
  );

  // update day entities
  updatePairDayData(event);
  updatePairHourData(event);
  updateVanguardDayData(event);
  updateTokenDayData(token0 as Token, event);
  updateTokenDayData(token1 as Token, event);
}

export function handleSwap(event: Swap): void {
  let pair = Pool.load(event.address.toHexString());
  if (!pair) return;

  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);
  if (!token0 || !token1) return;

  let amount0In = convertTokenToDecimal(
    event.params.amount0In,
    token0.decimals
  );

  let amount1In = convertTokenToDecimal(
    event.params.amount1In,
    token1.decimals
  );

  let amount0Out = convertTokenToDecimal(
    event.params.amount0Out,
    token0.decimals
  );

  let amount1Out = convertTokenToDecimal(
    event.params.amount1Out,
    token1.decimals
  );

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In);
  let amount1Total = amount1Out.plus(amount1In);

  // ETH/USD prices
  let bundle = Bundle.load("1");
  let bundleEthPrice = ZERO_BD;
  if (bundle) {
    bundleEthPrice = bundle.ethPrice;
  }

  // get total amounts of derived USD and ETH for tracking
  let derivedAmountETH = token1.derivedETH
    .times(amount1Total)
    .plus(token0.derivedETH.times(amount0Total))
    .div(BigDecimal.fromString("2"));
  let derivedAmountUSD = derivedAmountETH.times(bundleEthPrice);

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(
    amount0Total,
    token0 as Token,
    amount1Total,
    token1 as Token,
    pair as Pool
  );

  let trackedAmountETH: BigDecimal;
  if (bundleEthPrice.equals(ZERO_BD)) {
    trackedAmountETH = ZERO_BD;
  } else {
    trackedAmountETH = trackedAmountUSD.div(bundleEthPrice);
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD);
  pair.txCount = pair.txCount.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  let factory = Factory.load(FACTORY_ADDRESS);
  if (!factory) return;

  factory.totalVolumeUSD = factory.totalVolumeUSD.plus(trackedAmountUSD);
  factory.totalVolumeETH = factory.totalVolumeETH.plus(trackedAmountETH);
  factory.untrackedVolumeUSD = factory.untrackedVolumeUSD.plus(derivedAmountUSD);
  factory.txCount = factory.txCount.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  factory.save();

  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString());
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.swaps = [];
    transaction.burns = [];
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(
    event.transaction.hash
      .toHexString()
      .concat("-")
      .concat(BigInt.fromI32(swaps.length).toString())
  );

  // update swap event
  swap.transaction = transaction.id;
  swap.pool = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.to = event.params.to;
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD;
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();

  // update day entities
  let pairDayData = updatePairDayData(event);
  let pairHourData = updatePairHourData(event);
  let vanguardDayData = updateVanguardDayData(event);
  let token0DayData = updateTokenDayData(token0 as Token, event);
  let token1DayData = updateTokenDayData(token1 as Token, event);

  // swap specific updating
  vanguardDayData.dailyVolumeUSD = vanguardDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  vanguardDayData.dailyVolumeETH = vanguardDayData.dailyVolumeETH.plus(trackedAmountETH);
  vanguardDayData.dailyVolumeUntracked = vanguardDayData.dailyVolumeUntracked.plus(derivedAmountUSD);
  vanguardDayData.save();

  // swap specific updating for pair
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total);
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total);
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD);
  pairDayData.save();

  // update hourly pair data
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total);
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total);
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD);
  pairHourData.save();

  // swap specific updating for token0
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total);
  token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(
    amount0Total.times(token0.derivedETH as BigDecimal)
  );
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedETH as BigDecimal).times(bundleEthPrice)
  );
  token0DayData.save();

  // swap specific updating
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total);
  token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(
    amount1Total.times(token1.derivedETH as BigDecimal)
  );
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedETH as BigDecimal).times(bundleEthPrice)
  );
  token1DayData.save();
}
