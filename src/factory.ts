/* eslint-disable prefer-const */
import { log } from "@graphprotocol/graph-ts";

import {
  Bundle, Pool,
  Token, Factory,
} from "../generated/schema";

import {
  fetchTokenDecimals, fetchTokenName,
  fetchTokenSymbol, fetchTokenTotalSupply,
  ZERO_BD, ZERO_BI
} from "./helpers";

import { PoolCreated } from "../generated/ClassicFactory/ClassicFactory";
import { ClassicPool as PoolTemplate } from "../generated/templates";

export function handlePoolCreated(event: PoolCreated): void {
  // load factory (create if first exchange)
  let factory = Factory.load(event.address.toHexString());
  if (factory === null) {
    factory = new Factory(event.address.toHexString());
    factory.poolCount = 0;
    factory.totalVolumeETH = ZERO_BD;
    factory.totalLiquidityETH = ZERO_BD;
    factory.totalVolumeUSD = ZERO_BD;
    factory.untrackedVolumeUSD = ZERO_BD;
    factory.totalLiquidityUSD = ZERO_BD;
    factory.txCount = ZERO_BI;
    factory.userCount = ZERO_BI;

    // create new bundle
    let bundle = new Bundle("1");
    bundle.ethPrice = ZERO_BD;
    bundle.save();
  }
  factory.poolCount = factory.poolCount + 1;
  factory.save();

  let token0Address = event.params.token0;
  let token1Address = event.params.token1;

  // create the tokens
  let token0 = Token.load(token0Address.toHexString());
  let token1 = Token.load(token1Address.toHexString());

  // fetch info if null
  if (token0 === null) {
    token0 = new Token(token0Address.toHexString());
    token0.symbol = fetchTokenSymbol(token0Address);
    token0.name = fetchTokenName(token0Address);
    token0.totalSupply = fetchTokenTotalSupply(token0Address);
    let decimals = fetchTokenDecimals(token0Address);

    // bail if we couldn't figure out the decimals
    if (decimals === null) {
      log.debug("mybug the decimal on token 0 was null", []);
      return;
    }

    token0.decimals = decimals;
    token0.derivedETH = ZERO_BD;
    token0.tradeVolume = ZERO_BD;
    token0.tradeVolumeUSD = ZERO_BD;
    token0.untrackedVolumeUSD = ZERO_BD;
    token0.totalLiquidity = ZERO_BD;
    // token0.allPairs = []
    token0.txCount = ZERO_BI;
  }

  // fetch info if null
  if (token1 === null) {
    token1 = new Token(token1Address.toHexString());
    token1.symbol = fetchTokenSymbol(token1Address);
    token1.name = fetchTokenName(token1Address);
    token1.totalSupply = fetchTokenTotalSupply(token1Address);
    let decimals = fetchTokenDecimals(token1Address);

    // bail if we couldn't figure out the decimals
    if (decimals === null) {
      return;
    }
    token1.decimals = decimals;
    token1.derivedETH = ZERO_BD;
    token1.tradeVolume = ZERO_BD;
    token1.tradeVolumeUSD = ZERO_BD;
    token1.untrackedVolumeUSD = ZERO_BD;
    token1.totalLiquidity = ZERO_BD;
    // token1.allPairs = []
    token1.txCount = ZERO_BI;
  }

  let pair = new Pool(event.params.pool.toHexString()) as Pool;
  pair.token0 = token0.id;
  pair.token1 = token1.id;
  pair.liquidityProviderCount = ZERO_BI;
  pair.createdAtTimestamp = event.block.timestamp;
  pair.createdAtBlockNumber = event.block.number;
  pair.txCount = ZERO_BI;
  pair.reserve0 = ZERO_BD;
  pair.reserve1 = ZERO_BD;
  pair.trackedReserveETH = ZERO_BD;
  pair.reserveETH = ZERO_BD;
  pair.reserveUSD = ZERO_BD;
  pair.totalSupply = ZERO_BD;
  pair.volumeToken0 = ZERO_BD;
  pair.volumeToken1 = ZERO_BD;
  pair.volumeUSD = ZERO_BD;
  pair.untrackedVolumeUSD = ZERO_BD;
  pair.token0Price = ZERO_BD;
  pair.token1Price = ZERO_BD;

  // create the tracked contract based on the template
  PoolTemplate.create(event.params.pool);

  // save updated values
  token0.save();
  token1.save();
  pair.save();
  factory.save();
}
