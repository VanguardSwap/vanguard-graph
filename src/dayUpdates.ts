/* eslint-disable prefer-const */
import { BigDecimal, BigInt, ethereum } from "@graphprotocol/graph-ts";

import {
  Bundle, Pool, PoolDayData,
  PoolHourData, Token, TokenDayData,
  VanguardDayData, Factory
} from "../generated/schema";

import { FACTORY_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI } from "./helpers";

export function updateVanguardDayData(event: ethereum.Event): VanguardDayData {
  let factory = Factory.load(FACTORY_ADDRESS);
  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let dayStartTimestamp = dayID * 86400;
  let vanguardDayData = VanguardDayData.load(dayID.toString());

  if (vanguardDayData === null) {
    vanguardDayData = new VanguardDayData(dayID.toString());
    vanguardDayData.date = dayStartTimestamp;
    vanguardDayData.dailyVolumeUSD = ZERO_BD;
    vanguardDayData.dailyVolumeETH = ZERO_BD;
    vanguardDayData.totalVolumeUSD = ZERO_BD;
    vanguardDayData.totalVolumeETH = ZERO_BD;
    vanguardDayData.dailyVolumeUntracked = ZERO_BD;
    vanguardDayData.totalLiquidityETH = ZERO_BD;
    vanguardDayData.totalLiquidityUSD = ZERO_BD;
    vanguardDayData.txCount = ZERO_BI;
  }

  if (factory) {
    vanguardDayData.totalLiquidityUSD = factory.totalLiquidityUSD;
    vanguardDayData.totalLiquidityETH = factory.totalLiquidityETH;
    vanguardDayData.txCount = factory.txCount;
  }

  vanguardDayData.save();

  return vanguardDayData;
}

export function updatePairDayData(event: ethereum.Event): PoolDayData {
  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let dayStartTimestamp = dayID * 86400;

  let dayPairID = event.address
    .toHexString()
    .concat("-")
    .concat(BigInt.fromI32(dayID).toString());

  let pair = Pool.load(event.address.toHexString());
  if (!pair) return new PoolDayData(dayPairID);

  let pairDayData = PoolDayData.load(dayPairID);

  if (pairDayData === null) {
    pairDayData = new PoolDayData(dayPairID);
    pairDayData.date = dayStartTimestamp;
    pairDayData.token0 = pair.token0;
    pairDayData.token1 = pair.token1;
    pairDayData.poolAddress = event.address;
    pairDayData.dailyVolumeToken0 = ZERO_BD;
    pairDayData.dailyVolumeToken1 = ZERO_BD;
    pairDayData.dailyVolumeUSD = ZERO_BD;
    pairDayData.dailyTxns = ZERO_BI;
  }

  pairDayData.totalSupply = pair.totalSupply;
  pairDayData.reserve0 = pair.reserve0;
  pairDayData.reserve1 = pair.reserve1;
  pairDayData.reserveUSD = pair.reserveUSD;
  pairDayData.dailyTxns = pairDayData.dailyTxns.plus(ONE_BI);
  pairDayData.save();

  return pairDayData;
}

export function updatePairHourData(event: ethereum.Event): PoolHourData {
  let timestamp = event.block.timestamp.toI32();
  let hourIndex = timestamp / 3600; // get unique hour within unix history
  let hourStartUnix = hourIndex * 3600; // want the rounded effect

  let hourPairID = event.address
    .toHexString()
    .concat("-")
    .concat(BigInt.fromI32(hourIndex).toString());

  let pair = Pool.load(event.address.toHexString());
  let pairHourData = PoolHourData.load(hourPairID);
  if (pairHourData === null) {
    pairHourData = new PoolHourData(hourPairID);
    pairHourData.hourStartUnix = hourStartUnix;
    pairHourData.pool = event.address.toHexString();
    pairHourData.hourlyVolumeToken0 = ZERO_BD;
    pairHourData.hourlyVolumeToken1 = ZERO_BD;
    pairHourData.hourlyVolumeUSD = ZERO_BD;
    pairHourData.hourlyTxns = ZERO_BI;
    pairHourData.reserve0 = ZERO_BD;
    pairHourData.reserve1 = ZERO_BD;
    pairHourData.reserveUSD = ZERO_BD;
    pairHourData.totalSupply = ZERO_BD;
  }

  if (pair) {
    pairHourData.totalSupply = pair.totalSupply;
    pairHourData.reserve0 = pair.reserve0;
    pairHourData.reserve1 = pair.reserve1;
    pairHourData.reserveUSD = pair.reserveUSD;
  }

  pairHourData.hourlyTxns = pairHourData.hourlyTxns.plus(ONE_BI);
  pairHourData.save();

  return pairHourData;
}

export function updateTokenDayData(
  token: Token,
  event: ethereum.Event
): TokenDayData {
  let bundle = Bundle.load('1')
  let bundleEthPrice = ZERO_BD;
  if (bundle) {
    bundleEthPrice = bundle.ethPrice
  }

  let timestamp = event.block.timestamp.toI32();
  let dayID = timestamp / 86400;
  let dayStartTimestamp = dayID * 86400;

  let tokenDayID = token.id
    .toString()
    .concat("-")
    .concat(BigInt.fromI32(dayID).toString());

  let tokenDayData = TokenDayData.load(tokenDayID);
  if (tokenDayData === null) {
    tokenDayData = new TokenDayData(tokenDayID);
    tokenDayData.date = dayStartTimestamp;
    tokenDayData.token = token.id;
    tokenDayData.priceUSD = token.derivedETH.times(bundleEthPrice);
    tokenDayData.dailyVolumeToken = ZERO_BD;
    tokenDayData.dailyVolumeETH = ZERO_BD;
    tokenDayData.dailyVolumeUSD = ZERO_BD;
    tokenDayData.dailyTxns = ZERO_BI;
    tokenDayData.totalLiquidityUSD = ZERO_BD;
  }
  tokenDayData.priceUSD = token.derivedETH.times(bundleEthPrice);
  tokenDayData.totalLiquidityToken = token.totalLiquidity;
  tokenDayData.totalLiquidityETH = token.totalLiquidity.times(token.derivedETH as BigDecimal);
  tokenDayData.totalLiquidityUSD = tokenDayData.totalLiquidityETH.times(bundleEthPrice);
  tokenDayData.dailyTxns = tokenDayData.dailyTxns.plus(ONE_BI);
  tokenDayData.save();

  /**
   * @todo test if this speeds up sync
   */
  // updateStoredTokens(tokenDayData as TokenDayData, dayID)
  // updateStoredPairs(tokenDayData as TokenDayData, dayPairID)

  return tokenDayData;
}
