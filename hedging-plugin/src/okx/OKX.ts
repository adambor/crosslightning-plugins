import * as BN from "bn.js";
import {createHmac} from "crypto";

function toDecimal(amount: BN, decimalCount: number) {
    if(decimalCount<=0) {
        return amount.toString(10)+"0".repeat(-decimalCount);
    }

    const amountStr = amount.toString(10).padStart(decimalCount+1, "0");

    const splitPoint = amountStr.length-decimalCount;

    return amountStr.substring(0, splitPoint)+"."+amountStr.substring(splitPoint, amountStr.length);
}

function fromDecimal(amount: string, decimalCount: number) {

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
    "USDC": 18, //TODO: Change for other EVMs
    "USDT": 18, //TODO: Change for other EVMs
    "ETH": 18,
    "SOL": 9
};

export class OKXError extends Error {
    errorCode: string;
    data: any;

    constructor(msg: string, errorCode: string, data: any) {
        super(msg);
        this.errorCode = errorCode;
        this.data = data;
    }
}

export class OKX {

    private readonly apiBaseUrl: string;

    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly apiPassword: string;

    constructor(apiBaseUrl: string, apiKey: string, apiSecret: string, apiPassword: string) {
        this.apiBaseUrl = apiBaseUrl;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.apiPassword = apiPassword;
    }

    getTradingPair(srcCurrency: string, dstCurrency: string) {
        let tradingPair: string;
        let buy: boolean;

        if(srcCurrency==="BTC" || srcCurrency==="BTC-LN") {
            switch (dstCurrency) {
                case "USDC":
                    tradingPair = "BTC-USDC";
                    buy = false;
                    break;
                case "USDT":
                    tradingPair = "BTC-USDT";
                    buy = false;
                    break;
                case "ETH":
                    tradingPair = "ETH-BTC";
                    buy = true;
                    break;
                case "SOL":
                    tradingPair = "SOL-BTC";
                    buy = true;
                    break;
            }
        }
        if(dstCurrency==="BTC" || dstCurrency==="BTC-LN") {
            switch (srcCurrency) {
                case "USDC":
                    tradingPair = "BTC-USDC";
                    buy = true;
                    break;
                case "USDT":
                    tradingPair = "BTC-USDT";
                    buy = true;
                    break;
                case "ETH":
                    tradingPair = "ETH-BTC";
                    buy = false;
                    break;
                case "SOL":
                    tradingPair = "SOL-BTC";
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

        const resp = await this.call({
            path: "/api/v5/trade/order",
            method: "GET",
            params: {
                instId: tradingPair,
                clOrdId: orderId
            }
        });

        return {
            averagePrice: resp.data[0].avgPx,
            state: resp.data[0].state,
            orderId: resp.data[0].ordId
        };
    }

    async marketTrade(srcCurrency: string, dstCurrency: string, amount: BN, orderId: string): Promise<string> {
        const {tradingPair, buy} = this.getTradingPair(srcCurrency,dstCurrency);

        if(tradingPair==null) throw new Error("Invalid trade pair");

        const resp = await this.call({
            path: "/api/v5/trade/order",
            method: "POST",
            data: {
                instId: tradingPair,
                tdMode: "cash",
                clOrdId: orderId,
                side: buy ? "buy" : "sell",
                ordType: "market",
                sz: toDecimal(amount, currencyDecimals[srcCurrency]),
                //tgtCcy: !buy ? "base_ccy" : "quote_ccy"
            }
        });

        console.log("Resp: ", resp);

        return resp.data[0].ordId;
    }

    async getFundsTransfer(transferId: string): Promise<{
        state: "success" | "pending" | "failed",
        transId: string
    }> {

        const resp = await this.call({
            path: "/api/v5/asset/transfer-state",
            method: "GET",
            params: {
                clientId: transferId
            }
        });

        return resp.data[0];

    }

    /**
     * This call may throw an OKX exception but still be processed!
     * @param currency
     * @param fromAcc
     * @param toAcc
     * @param amount
     * @param transferId
     */
    async fundsTransfer(currency: string, fromAcc: "funding" | "trading", toAcc: "funding" | "trading", amount: BN, transferId: string): Promise<string> {

        const resp = await this.call({
            path: "/api/v5/asset/transfer",
            method: "POST",
            data: {
                ccy: currency,
                amt: toDecimal(amount, currencyDecimals[currency]),
                from: fromAcc==="funding" ? "6" : "18",
                to: toAcc==="funding" ? "6" : "18",
                clientId: transferId
            }
        });

        return resp.data[0].transId;

    }

    async getBalance(currency: string): Promise<BN> {
        const resp = await this.call({
            path: "/api/v5/account/balance",
            method: "GET",
            params: {
                ccy: currency
            }
        });

        if(resp.data[0].details[0]==null) return new BN(0);

        return fromDecimal(resp.data[0].details[0].cashBal, currencyDecimals[currency]);
    }

    async getWithdrawalFee(currency: string, chain: string, amount: BN): Promise<BN> {
        if(currency==="BTC-LN") {
            return new BN(1000).add(amount.div(new BN(1000)));
        }

        const respCurrencies = await this.call({
            path: "/api/v5/asset/currencies",
            method: "GET",
            params: {
                ccy: currency
            }
        });

        const currencyData: {
            minFee: string,
            maxFee: string,
            canWd: boolean
        } = respCurrencies.data.find(e => e.chain===currency+"-"+(currency==="BTC" ? "Bitcoin" : chain));

        if(currencyData==null) throw new Error("Chain in currency not found");
        if(!currencyData.canWd) throw new Error("Cannot withdraw the desired currency");

        return fromDecimal(currencyData.maxFee, currencyDecimals[currency]);
    }

    async getWithdrawal(withdrawalId: string): Promise<{
        state: string,
        txId: string
    }> {
        const resp = await this.call({
            path: "/api/v5/asset/withdrawal-history",
            method: "GET",
            params: {
                clientId: withdrawalId
            }
        });

        return resp.data[0];
    }

    async withdraw(currency: string, chain: string, address: string, withdrawalId: string, fee: BN, amount?: BN): Promise<string> {

        if(currency==="BTC-LN") {
            const resp = await this.call({
                path: "/api/v5/asset/withdrawal-lightning",
                method: "POST",
                data: {
                    ccy: "BTC",
                    invoice: address
                }
            });

            return resp.data.invoice;
        }

        if(amount==null) throw new Error("Withdrawals must have an amount!");


        const resp = await this.call({
            path: "/api/v5/asset/withdrawal",
            method: "POST",
            data: {
                ccy: currency,
                amt: toDecimal(amount, currencyDecimals[currency]),
                dest: "4",
                toAddr: address,
                chain: currency+"-"+(currency==="BTC" ? "Bitcoin" : chain),
                clientId: withdrawalId,
                fee: toDecimal(fee, currencyDecimals[currency])
            }
        });

        return resp.data.wdId;

    }

    async getDeposit(txId: string): Promise<{
        state: string,
        depId: string
    }> {
        const resp = await this.call({
            path: "/api/v5/asset/deposit-history",
            method: "GET",
            params: {
                txId
            }
        });

        return resp.data[0];
    }

    async getDepositAddress(currency: string, chain: string, amount?: BN): Promise<string> {

        if(currency==="BTC-LN") {
            if(amount==null) throw new Error("Lightning deposits must have an amount!");

            const resp = await this.call({
                path: "/api/v5/asset/deposit-lightning",
                method: "GET",
                params: {
                    ccy: "BTC",
                    amt: toDecimal(amount, 8),
                    to: "18"
                }
            });

            //TODO: Check if an invoice with valid amount was returned

            return resp.data[0].invoice;
        }

        const resp = await this.call({
            path: "/api/v5/asset/deposit-address",
            method: "GET",
            params: {
                ccy: currency,
                to: "18"
            }
        });

        const data: {
            chain: string,
            addr: string
        }[] = resp.data;

        const found = data.find(e => e.chain===currency+"-"+(currency==="BTC" ? "Bitcoin" : chain));

        return found?.addr;

    }

    async call({
        path,
        method,
        params,
        data,
        timeout = 5000
    }: {
        path: string,
        method: "GET" | "POST",
        params?: Record<string, string>,
        data?: Record<string, any>,
        timeout?: number
    }): Promise<{
        code: string,
        msg: string,
        data: any
    }> {

        console.log("Data: ", data);

        const timestamp = new Date().toISOString();

        let requestUrl = `${this.apiBaseUrl}${path}`;
        let requestPath = path;
        if(params!=null) {
            const paramString = Object.keys(params).map(key => key+"="+encodeURIComponent(params[key])).join("&");
            requestUrl = requestUrl + "?" + paramString;
            requestPath = requestPath + "?" + paramString;
        }

        let dataSerialize = data === null || data === undefined ? '' : JSON.stringify(data);
        if (dataSerialize === '{}') {
            dataSerialize = '';
        }

        const signHeaders = {
            'Content-Type': "application/json",
            'OK-ACCESS-KEY': this.apiKey || '',
            'OK-ACCESS-SIGN': createHmac('sha256', this.apiSecret).update(timestamp + method + requestPath + dataSerialize).digest('base64'),
            'OK-ACCESS-TIMESTAMP': timestamp,
            'OK-ACCESS-PASSPHRASE': this.apiPassword,
        };

        const result = await fetch(requestUrl, {
            method,
            headers: signHeaders,
            body: dataSerialize==='' ? null : dataSerialize
        });

        const response = await result.json();
        if (typeof response.code !== 'string' || typeof response.msg !== 'string') {
            throw new Error("Invalid response");
        }

        console.log("response: ", response);

        if(response.code!=="0") {
            throw new OKXError(response.msg, response.code, response.data);
        }

        return {
            code: response.code,
            msg: response.msg,
            data: response.data
        }
    }

}