/* eslint-disable prefer-const */
import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";

import { ERC20 } from "../generated/ClassicFactory/ERC20";
import { ERC20NameBytes } from "../generated/ClassicFactory/ERC20NameBytes";
import { ERC20SymbolBytes } from "../generated/ClassicFactory/ERC20SymbolBytes";
import { User, UserPosition } from "../generated/schema";
import { ClassicFactory as FactoryContract } from "../generated/templates/ClassicPool/ClassicFactory";

export const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";
export const FACTORY_ADDRESS = "0x16d6d5627a6d4da55ce81b624ad31e42e163b9c4";

export let ZERO_BI = BigInt.fromI32(0);
export let ONE_BI = BigInt.fromI32(1);
export let ZERO_BD = BigDecimal.fromString("0");
export let ONE_BD = BigDecimal.fromString("1");
export let BI_18 = BigInt.fromI32(18);

export let factoryContract = FactoryContract.bind(
  Address.fromString(FACTORY_ADDRESS)
);

// rebass tokens, dont count in tracked volume
export let UNTRACKED_PAIRS: string[] = [
  "0x9ea3b5b4ec044b70375236a281986106457b20ef",
];

export function updateUserPosition(
  user: Address,
  pool: Address,
  amount0: BigInt,
  amount1: BigInt,
  liquidity: BigInt,
  isMint: boolean
): void {
  let userPosition = UserPosition.load(user.toHexString() + "-" + pool.toHexString());

  if (!userPosition) {
    userPosition = new UserPosition(user.toHexString() + "-" + pool.toHexString());
    userPosition.user = user;
    userPosition.pool = pool.toHexString();
    userPosition.liquidity = ZERO_BD;
    userPosition.amount0 = ZERO_BI;
    userPosition.amount1 = ZERO_BI;
  }

  let newLiquidity = convertTokenToDecimal(liquidity, BI_18);

  if (isMint) {
    userPosition.liquidity = userPosition.liquidity.plus(newLiquidity);
    userPosition.amount0 = userPosition.amount0.plus(amount0);
    userPosition.amount1 = userPosition.amount1.plus(amount1);
  } else {
    userPosition.liquidity = userPosition.liquidity.minus(newLiquidity);
    userPosition.amount0 = userPosition.amount0.minus(amount0);
    userPosition.amount1 = userPosition.amount1.minus(amount1);
  }

  userPosition.save();
}

export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let bd = BigDecimal.fromString("1");
  for (let i = ZERO_BI; i.lt(decimals as BigInt); i = i.plus(ONE_BI)) {
    bd = bd.times(BigDecimal.fromString("10"));
  }
  return bd;
}

export function bigDecimalExp18(): BigDecimal {
  return BigDecimal.fromString("1000000000000000000");
}

export function convertEthToDecimal(eth: BigInt): BigDecimal {
  return eth.toBigDecimal().div(exponentToBigDecimal(BI_18));
}

export function convertTokenToDecimal(
  tokenAmount: BigInt,
  exchangeDecimals: BigInt
): BigDecimal {
  if (exchangeDecimals == ZERO_BI) {
    return tokenAmount.toBigDecimal();
  }
  return tokenAmount.toBigDecimal().div(exponentToBigDecimal(exchangeDecimals));
}

export function equalToZero(value: BigDecimal): boolean {
  const formattedVal = parseFloat(value.toString());
  const zero = parseFloat(ZERO_BD.toString());
  if (zero == formattedVal) {
    return true;
  }
  return false;
}

export function isNullEthValue(value: string): boolean {
  return (
    value ==
    "0x0000000000000000000000000000000000000000000000000000000000000001"
  );
}

export function fetchTokenSymbol(tokenAddress: Address): string {
  let contract = ERC20.bind(tokenAddress);
  let contractSymbolBytes = ERC20SymbolBytes.bind(tokenAddress);

  // try types string and bytes32 for symbol
  let symbolValue = "unknown";
  let symbolResult = contract.try_symbol();
  if (symbolResult.reverted) {
    let symbolResultBytes = contractSymbolBytes.try_symbol();
    if (!symbolResultBytes.reverted) {
      // for broken pairs that have no symbol function exposed
      if (!isNullEthValue(symbolResultBytes.value.toHexString())) {
        symbolValue = symbolResultBytes.value.toString();
      }
    }
  } else {
    symbolValue = symbolResult.value;
  }

  return symbolValue;
}

export function fetchTokenName(tokenAddress: Address): string {
  let contract = ERC20.bind(tokenAddress);
  let contractNameBytes = ERC20NameBytes.bind(tokenAddress);

  // try types string and bytes32 for name
  let nameValue = "unknown";
  let nameResult = contract.try_name();
  if (nameResult.reverted) {
    let nameResultBytes = contractNameBytes.try_name();
    if (!nameResultBytes.reverted) {
      // for broken exchanges that have no name function exposed
      if (!isNullEthValue(nameResultBytes.value.toHexString())) {
        nameValue = nameResultBytes.value.toString();
      }
    }
  } else {
    nameValue = nameResult.value;
  }

  return nameValue;
}

// HOT FIX: we cant implement try catch for overflow catching so skip total supply parsing on these tokens that overflow
// TODO: find better way to handle overflow
let SKIP_TOTAL_SUPPLY: string[] = [
  "0x0000000000bf2686748e1c0255036e7617e7e8a5",
];

export function fetchTokenTotalSupply(tokenAddress: Address): BigInt {
  if (SKIP_TOTAL_SUPPLY.includes(tokenAddress.toHexString())) {
    return BigInt.fromI32(0);
  }
  const contract = ERC20.bind(tokenAddress);
  let totalSupplyValue = BigInt.zero();
  const totalSupplyResult = contract.try_totalSupply();
  if (!totalSupplyResult.reverted) {
    totalSupplyValue = totalSupplyResult.value;
  }
  return totalSupplyValue;
}

export function fetchTokenDecimals(tokenAddress: Address): BigInt | null {
  let contract = ERC20.bind(tokenAddress);
  let decimalResult = contract.try_decimals();
  if (!decimalResult.reverted) {
    if (decimalResult.value.lt(BigInt.fromI32(255))) {
      return decimalResult.value;
    }
  }
  return null;
}

export function createUser(address: Address): void {
  let user = User.load(address.toHexString());
  if (user === null) {
    user = new User(address.toHexString());
    user.usdSwapped = ZERO_BD;
    user.save();
  }
}
