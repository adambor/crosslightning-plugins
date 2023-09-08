import * as BN from "bn.js";
import {createHmac} from "crypto";
import {DepositAddressResponse, generateNewOrderId, MainClient} from "binance";
import * as bolt11 from "bolt11";

function toDecimal(amount: BN, decimalCount: number): string {
    if(decimalCount<=0) {
        return amount.toString(10)+"0".repeat(-decimalCount);
    }

    const amountStr = amount.toString(10).padStart(decimalCount+1, "0");

    const splitPoint = amountStr.length-decimalCount;

    return amountStr.substring(0, splitPoint)+"."+amountStr.substring(splitPoint, amountStr.length);
}

function fromDecimal(amount: string, decimalCount: number): BN {

    if(amount.includes(".")) {
        const [before, after] = amount.split(".");
        if(decimalCount<0) {
            return new BN(before.substring(0, before.length+decimalCount));
        }
        if(after.length>decimalCount) {
            //Cut the last digits
            return new BN((before==="0" ? "" : before)+after.substring(0, decimalCount));
        }
        return new BN((before==="0" ? "" : before)+after.padEnd(decimalCount, "0"));
    } else {
        if(decimalCount<0) {
            return new BN(amount.substring(0, amount.length+decimalCount));
        } else {
            return new BN(amount+"0".repeat(decimalCount));
        }
    }

}

const currencyDecimals = {
    "BTC": 8,
    "BTC-LN": 8,
    "USDC": 6, //TODO: Change for other EVMs
    "USDT": 6, //TODO: Change for other EVMs
    "ETH": 18,
    "SOL": 9
};

export class BinanceError extends Error {
    errorCode: string;
    data: any;

    constructor(msg: string, errorCode: string, data: any) {
        super(msg);
        this.errorCode = errorCode;
        this.data = data;
    }
}

export class Binance {

    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly client: MainClient;

    constructor(apiKey: string, apiSecret: string) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.client = new MainClient({
            api_secret: this.apiSecret,
            api_key: this.apiKey
        })
    }

    generateOrderId(): string {
        return generateNewOrderId("spot");
    }

    getTradingPair(srcCurrency: string, dstCurrency: string) {
        let tradingPair: string;
        let buy: boolean;

        if(srcCurrency==="BTC" || srcCurrency==="BTC-LN") {
            switch (dstCurrency) {
                case "USDC":
                    tradingPair = "BTCUSDC";
                    buy = false;
                    break;
                case "USDT":
                    tradingPair = "BTCUSDT";
                    buy = false;
                    break;
                case "ETH":
                    tradingPair = "ETHBTC";
                    buy = true;
                    break;
                case "SOL":
                    tradingPair = "SOLBTC";
                    buy = true;
                    break;
            }
        }
        if(dstCurrency==="BTC" || dstCurrency==="BTC-LN") {
            switch (srcCurrency) {
                case "USDC":
                    tradingPair = "BTCUSDC";
                    buy = true;
                    break;
                case "USDT":
                    tradingPair = "BTCUSDT";
                    buy = true;
                    break;
                case "ETH":
                    tradingPair = "ETHBTC";
                    buy = false;
                    break;
                case "SOL":
                    tradingPair = "SOLBTC";
                    buy = false;
                    break;
            }
        }

        return {
            buy,
            tradingPair
        }
    }

    async getTrade(srcCurrency: string, dstCurrency: string, orderId: string): Promise<{
        averagePrice: string,
        state: "canceled" | "live" | "partially_filled" | "filled" | "mmp_canceled",
        orderId: string
    }> {
        const {tradingPair, buy} = this.getTradingPair(srcCurrency,dstCurrency);

        if(tradingPair==null) throw new Error("Invalid trade pair");

        let resp;
        try {
            resp = await this.client.getOrder({
                symbol: tradingPair,
                origClientOrderId: orderId
            });
        } catch (e) {
            throw new BinanceError(e.message, ""+e.code, e.body);
        }

        let state: "canceled" | "live" | "partially_filled" | "filled" | "mmp_canceled";

        if(resp.status==="CANCELED") state = "canceled";
        if(resp.status==="NEW") state = "live";
        if(resp.status==="PARTIALLY_FILLED") state = "partially_filled";
        if(resp.status==="FILLED") state = "filled";
        if(resp.status==="REJECTED") state = "mmp_canceled";

        return {
            averagePrice: toDecimal(
                fromDecimal(resp.cummulativeQuoteQty.toString(), 12)
                    .div(fromDecimal(resp.executedQty.toString(), 9)),
                3),
            state,
            orderId: resp.orderId.toString(10)
        };
    }

    async marketTrade(srcCurrency: string, dstCurrency: string, amount: BN, orderId: string): Promise<string> {
        const {tradingPair, buy} = this.getTradingPair(srcCurrency,dstCurrency);

        if(tradingPair==null) throw new Error("Invalid trade pair");

        const amt = toDecimal(amount, currencyDecimals[srcCurrency]);
        console.log("Trade qty: ", "'"+amt+"'");
        let resp;
        try {
            const params: any = {
                symbol: tradingPair,
                side: buy ? "BUY" : "SELL",
                type: "MARKET",
                newClientOrderId: orderId
            };
            if(!buy) {
                params.quantity = amt;
            } else {
                params.quoteOrderQty = amt;
            }
            resp = await this.client.submitNewOrder(params);
        } catch (e) {
            throw new BinanceError(e.message, ""+e.code, e.body);
        }

        console.log("Resp: ", resp);

        return resp.orderId.toString(10);
    }

    async getBalance(currency: string): Promise<BN> {
        if(currency==="BTC-LN") {
            currency = "BTC";
        }
        let balances;
        try {
            balances = await this.client.getBalances();
        } catch (e) {
            throw new BinanceError(e.message, ""+e.code, e.body);
        }

        const balance = balances.find(e => e.coin===currency);

        if(balance==null) return new BN(0);

        return fromDecimal(""+balance.free, currencyDecimals[currency]);
    }

    async getWithdrawalFee(currency: string, chain: string): Promise<BN> {
        if(currency==="BTC") {
            chain = "BTC";
        }
        if(currency==="BTC-LN") {
            currency = "BTC";
            chain = "LIGHTNING";
        }

        let balances;
        try {
            balances = await this.client.getBalances();
        } catch (e) {
            throw new BinanceError(e.message, ""+e.code, e.body);
        }

        const balance = balances.find(e => e.coin===currency);

        if(balance==null) throw new Error("Currency not found");

        const networkData = balance.networkList.find(e => e.network===chain);

        if(networkData==null) throw new Error("Chain in currency not found");

        return fromDecimal(""+networkData.withdrawFee, currencyDecimals[currency]);
    }

    async getWithdrawal(withdrawalId: string): Promise<{
        state: "2" | "1" | "0" | "-1" | "-2" | "-3",
        txId: string
    }> {
        let resp;
        try {
            resp = await this.client.getWithdrawHistory({
                withdrawOrderId: withdrawalId
            });
        } catch (e) {
            throw new BinanceError(e.message, ""+e.code, e.body);
        }

        if(resp[0]==null) return null;

        let state: "2" | "1" | "0" | "-1" | "-2" | "-3";

        if(resp[0].status===6) state = "2"; //Completed
        if(resp[0].status===4) state = "1"; //Processing
        if(resp[0].status===0 || resp[0].status===2) state = "0"; //Email sent, awaiting approval
        if(resp[0].status===1) state = "-1"; //Cancelled
        if(resp[0].status===3) state = "-2"; //Rejected
        if(resp[0].status===5) state = "-3"; //Failed

        return {
            state: state,
            txId: resp[0].txId
        };
    }

    async withdraw(currency: string, chain: string, address: string, withdrawalId: string, withdrawalFee: BN, amount?: BN): Promise<string> {

        if(currency==="BTC") {
            chain = "BTC";
        }

        if(currency==="BTC-LN") {
            currency = "BTC";
            chain = "LIGHTNING";
            amount = new BN(bolt11.decode(address).satoshis);
        } else {
            if(amount==null) throw new Error("Withdrawals must have an amount!");
        }

        let resp;
        try {
            resp = await this.client.withdraw({
                coin: currency,
                withdrawOrderId: withdrawalId,
                network: chain,
                address: address,
                walletType: 0,
                //@ts-ignore
                amount: toDecimal(amount.add(withdrawalFee), currencyDecimals[currency])
            });
        } catch (e) {
            throw new BinanceError(e.message, ""+e.code, e.body);
        }

        return resp.id;

    }

    async getDeposit(txId: string): Promise<{
        state: "-1" | "0" | "1" | "2",
        depId: string
    }> {
        let resp;
        try {
            resp = await this.client.getDepositHistory({
                // @ts-ignore
                txId
            });
        } catch (e) {
            throw new BinanceError(e.message, ""+e.code, e.body);
        }

        if(resp[0]==null) return null;

        let state: "-1" | "0" | "1" | "2";

        if(resp[0].status===1) state = "2"; //success
        if(resp[0].status===6) state = "1"; //Credited but cannot withdraw
        if(resp[0].status===0 || resp[0].status===8) state = "0"; //pending & waiting user confirm
        if(resp[0].status===7) state = "-1"; //wrong deposit

        return {
            depId: resp[0].txId,
            state
        };
    }

    async getDepositAddress(currency: string, chain: string, amount?: BN): Promise<string> {

        let resp: DepositAddressResponse;
        if(currency==="BTC-LN") {
            currency = "BTC";
            chain = "LIGHTNING";
            if(amount==null) throw new Error("Lightning deposits must have an amount!");

            try {
                resp = await this.client.getDepositAddress({
                    coin: currency,
                    network: chain,
                    // @ts-ignore
                    amount: toDecimal(amount, 8)
                });
            } catch (e) {
                throw new BinanceError(e.message, ""+e.code, e.body);
            }
        } else {
            if(currency==="BTC") chain = "SEGWITBTC";
            try {
                resp = await this.client.getDepositAddress({
                    coin: currency,
                    network: chain
                });
            } catch (e) {
                throw new BinanceError(e.message, ""+e.code, e.body);
            }
        }

        return resp.address;

    }

}