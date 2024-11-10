import { Transfer as TransferEvent } from "../generated/templates/ERC20/ERC20";
import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { ADDRESS_ZERO, convertTokenToDecimal } from "./helpers";
import { Token, User, UserTokenBalance } from "../generated/schema";
import { ERC20 as ERC20Contract } from "../generated/templates/ERC20/ERC20";

export function handleTransfer(event: TransferEvent): void {
  updateBalances(
    event.address,
    event.params.from,
    event.params.to,
    event.params.value
  );
}

function updateWalletBalance(
  token: Token,
  tokenAddress: Address,
  wallet: Address,
  amount: BigDecimal,
  isAddition: boolean
): void {
  let walletId = token.id + "-" + wallet.toHexString();
  let walletBalance = UserTokenBalance.load(walletId);

  if (!walletBalance) {
    walletBalance = new UserTokenBalance(walletId);
    walletBalance.token = token.id;
    walletBalance.user = wallet.toHexString();

    walletBalance.balance = convertTokenToDecimal(
        ERC20Contract.bind(tokenAddress).balanceOf(wallet),
        token.decimals
    );
  } else {
    walletBalance.balance = isAddition
      ? walletBalance.balance.plus(amount)
      : walletBalance.balance.minus(amount);
  }

  walletBalance.save();
}

export function updateBalances(
  token: Address,
  from: Address,
  to: Address,
  amount: BigInt
): void {
  let userFrom = User.load(from.toHexString());
  let userTo = User.load(to.toHexString());

  if (!userFrom && !userTo) return;

  let tokenEntity = Token.load(token.toHexString());
  if (!tokenEntity) return;

  let amountDecimal = convertTokenToDecimal(amount, tokenEntity.decimals);

  if (from.toHexString() != ADDRESS_ZERO) {
    updateWalletBalance(tokenEntity, token, from, amountDecimal, false);
  }

  if (to.toHexString() != ADDRESS_ZERO) {
    updateWalletBalance(tokenEntity, token, to, amountDecimal, true);
  }
}
