/* eslint-disable prefer-const */
import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts/index";
import { Bundle, Pool, Token } from "../generated/schema";

import {
  ADDRESS_ZERO, factoryContract,
  ONE_BD, UNTRACKED_PAIRS, ZERO_BD
} from "./helpers";

const WETH_ADDRESS = "0x968b9a5603ddeb2a78aa08182bc44ece1d9e5bf0";
const USDC_WETH_PAIR = "0xe2e8a2b05f050498a951b006bd2863ebbbc5b587";
const USDT_WETH_PAIR = "0x69dbefd8e8552520ff196650ffb10119d0d183f6";

export function getEthPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  let usdcPair = Pool.load(USDC_WETH_PAIR); // usdc is token0
  let usdtPair = Pool.load(USDT_WETH_PAIR); // usdt is token0

  // all 2 have been created
  if (usdcPair !== null && usdtPair !== null) {
    let totalLiquidityETH = usdcPair.reserve1.plus(usdtPair.reserve1);

    let usdcWeight = usdcPair.reserve1.div(totalLiquidityETH);
    let usdtWeight = usdtPair.reserve0.div(totalLiquidityETH);

    return usdcPair.token0Price.times(usdcWeight)
      .plus(usdtPair.token1Price.times(usdtWeight));
    // dai and USDC have been created
  } else if (usdcPair !== null) {
    return usdcPair.token0Price;
  } else {
    return ZERO_BD;
  }
}

// token where amounts should contribute to tracked volume and liquidity
let WHITELIST: string[] = [
  "0x968b9a5603ddeb2a78aa08182bc44ece1d9e5bf0", // WETH
  "0x700722d24f9256be288f56449e8ab1d27c4a70ca", // USDC
  "0x8812d810ea7cc4e1c3fb45cef19d6a7ecbf2d85d", // USDT
  "0x153b112138c6de2cad16d66b4b6448b7b88caef3", // WBTC
  "0x6e990040fd9b06f98efb62a147201696941680b5", // WIP
];

// minimum liquidity required to count towards tracked volume for pairs with small # of Lps
let MINIMUM_USD_THRESHOLD_NEW_PAIRS = BigDecimal.fromString("0");

// minimum liquidity for price to get tracked
let MINIMUM_LIQUIDITY_THRESHOLD_ETH = BigDecimal.fromString("0");

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(token: Token): BigDecimal {
  if (token.id == WETH_ADDRESS) {
    return ONE_BD;
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    let pairAddress = factoryContract.getPool(
      Address.fromString(token.id),
      Address.fromString(WHITELIST[i])
    );
    if (pairAddress.toHexString() != ADDRESS_ZERO) {
      let pair = Pool.load(pairAddress.toHexString());
      if (pair === null) {
        continue;
      }
      if (
        pair.token0 == token.id &&
        pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)
      ) {
        let token1 = Token.load(pair.token1);
        if (token1 === null) {
          continue;
        }
        return pair.token1Price.times(token1.derivedETH as BigDecimal); // return token1 per our token * Eth per token 1
      }
      if (
        pair.token1 == token.id &&
        pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)
      ) {
        let token0 = Token.load(pair.token0);
        if (token0 === null) {
          continue;
        }
        return pair.token0Price.times(token0.derivedETH as BigDecimal); // return token0 per our token * ETH per token 0
      }
    }
  }
  return ZERO_BD; // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  pair: Pool
): BigDecimal {
  let bundle = Bundle.load('1')
  let bundleEthPrice = ZERO_BD;
  if (bundle) {
    bundleEthPrice = bundle.ethPrice
  }

  let price0 = token0.derivedETH.times(bundleEthPrice);
  let price1 = token1.derivedETH.times(bundleEthPrice);

  // dont count tracked volume on these pairs - usually rebass tokens
  if (UNTRACKED_PAIRS.includes(pair.id)) {
    return ZERO_BD;
  }

  // if less than 5 LPs, require high minimum reserve amount amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    let reserve0USD = pair.reserve0.times(price0);
    let reserve1USD = pair.reserve1.times(price1);
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD;
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (
        reserve0USD
          .times(BigDecimal.fromString("2"))
          .lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)
      ) {
        return ZERO_BD;
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (
        reserve1USD
          .times(BigDecimal.fromString("2"))
          .lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)
      ) {
        return ZERO_BD;
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0
      .times(price0)
      .plus(tokenAmount1.times(price1))
      .div(BigDecimal.fromString("2"));
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0);
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1);
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let bundle = Bundle.load('1')
  let bundleEthPrice = ZERO_BD;
  if (bundle) {
    bundleEthPrice = bundle.ethPrice
  }

  let price0 = token0.derivedETH.times(bundleEthPrice);
  let price1 = token1.derivedETH.times(bundleEthPrice);

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1));
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString("2"));
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString("2"));
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}
