
import {FromBtcAbs, FromBtcLnAbs, FromBtcLnSwapState, FromBtcSwapState, IPlugin,
    ISwapPrice,
    SwapHandler, SwapHandlerSwap} from "crosslightning-intermediary";
import {BitcoinRpc, BtcBlock, BtcRelay, ChainEvents, SwapContract, SwapData} from "crosslightning-base";
import {AuthenticatedLnd} from "lightning";
import {RESTv2} from 'bitfinex-api-node';
import {Order} from "bfx-api-node-models";
import {OKX, OKXError} from "./okx/OKX";
import * as lncli from "ln-service";
import * as BN from "bn.js";
import * as fs from "fs/promises";
import {randomBytes} from "crypto";
import * as bolt11 from "bolt11";
import * as bitcoin from "bitcoinjs-lib";

type TokenAddresses = {
    WBTC: string,
    USDC: string,
    USDT: string,
    ETH?: string
};

enum RebalancingState {
    RETRYING=-1,

    IDLE=0,

    TRIGGERED=1,

    SC_WITHDRAWING=2,
    SC_WITHDRAWAL_CONFIRMED=3,

    OUT_TX=4,
    OUT_TX_CONFIRMED=5,
    DEPOSIT_RECEIVED=6,
    TRADE_EXECUTING=7,
    TRADE_EXECUTED=8,

    FUNDS_TRANSFERING=9,
    FUNDS_TRANSFERED=10,

    WITHDRAWING=11,
    WITHDRAWAL_SENT=12,
    IN_TX_CONFIRMED=13,

    SC_DEPOSITING=14,
    SC_DEPOSITED=15,

    FINISHED=16
}

type HedgingPluginState = {
    state: RebalancingState,

    cooldown?: number, //Only run check() if current timestamp > cooldown

    //RETRYING
    retryAt?: number,
    retryState?: RebalancingState,

    //TRIGGERED
    srcToken?: string,
    srcTokenAddress?: string,
    dstToken?: string,
    dstTokenAddress?: string,
    amountOut?: BN,

    //SC_WITHDRAWING
    scWithdrawTxs?: {[txId: string]: string};

    //SC_WITHDRAWAL_CONFIRMED
    scWithdrawTxId?: string;


    //OUT_TX
    outTxs?: {[txId: string]: string},

    //OUT_TX_CONFIRMED
    outTxId?: string,

    //DEPOSIT_RECEIVED
    depositId?: string;

    //TRADE_EXECUTING
    clientOrderId?: string,

    //TRADE_EXECUTED
    orderId?: string,
    price?: string,
    amountIn?: BN,

    //FUNDS_TRANSFERING
    clientTransferId?: string,

    //FUNDS_TRANSFERED
    transferId?: string,

    //WITHDRAWING
    receivingAddress?: string,
    withdrawalFee?: BN,
    withdrawalId?: string,

    //WITHDRAWAL_SENT
    inTxId?: string,

    //SC_DEPOSITING
    scDepositTxs?: {[txId: string]: string},

    //SC_DEPOSITED
    scDepositTxId?: string,
};

const REQUIRED_FIELDS = {
    [RebalancingState.RETRYING]: ["retryAt", "retryState"],
    [RebalancingState.IDLE]: [],
    [RebalancingState.TRIGGERED]: ["srcToken", "srcTokenAddress", "dstToken", "dstTokenAddress", "amountOut"],
    [RebalancingState.SC_WITHDRAWING]: ["scWithdrawTxs"],
    [RebalancingState.SC_WITHDRAWAL_CONFIRMED]: ["scWithdrawTxId"],
    [RebalancingState.OUT_TX]: ["outTxs"],
    [RebalancingState.OUT_TX_CONFIRMED]: ["outTxId"],
    [RebalancingState.DEPOSIT_RECEIVED]: ["depositId"],
    [RebalancingState.TRADE_EXECUTING]: ["clientOrderId"],
    [RebalancingState.TRADE_EXECUTED]: ["orderId", "price", "amountIn"],
    [RebalancingState.FUNDS_TRANSFERING]: ["clientTransferId"],
    [RebalancingState.FUNDS_TRANSFERED]: ["transferId"],
    [RebalancingState.WITHDRAWING]: ["receivingAddress", "withdrawalFee","withdrawalId"],
    [RebalancingState.WITHDRAWAL_SENT]: ["inTxId"],
    [RebalancingState.IN_TX_CONFIRMED]: [],
    [RebalancingState.SC_DEPOSITING]: ["scDepositTxs"],
    [RebalancingState.SC_DEPOSITED]: ["scDepositTxId"],
    [RebalancingState.FINISHED]: []
};

const STATE_FILENAME = "hedge-plugin-state.json";

const retryTime = 15*1000;
const checkInterval = 5*1000;

export class HedgingPlugin<T extends SwapData> implements IPlugin<T> {

    name: string = "Automatic hedging plugin";
    author: string = "adambor";
    description: string;

    private readonly apiKey: string;
    private readonly apiSecret: string;
    private readonly apiPassword: string;

    private readonly tokenAddresses: TokenAddresses;
    private readonly swapPricing: ISwapPrice;

    private fromBtcLn: FromBtcLnAbs<T>;
    private fromBtc: FromBtcAbs<T>;

    private swapContract: SwapContract<T, any>;
    private lnd: AuthenticatedLnd;
    private okxV5Api: OKX;

    private bitcoinRpc: BitcoinRpc<BtcBlock>;

    private readonly okxSmartChainName: string;

    private btcDepositAddress: string;

    constructor(apiKey: string, apiSecret: string, apiPassword: string, tokenAddresses: TokenAddresses, swapPricing: ISwapPrice, okxSmartChainName: string, bitcoinRpc: BitcoinRpc<BtcBlock>) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.apiPassword = apiPassword;
        this.tokenAddresses = tokenAddresses;
        this.tokenAddresses.ETH = "0x0000000000000000000000000000000000000000";
        this.swapPricing = swapPricing;
        this.okxSmartChainName = okxSmartChainName;
        this.bitcoinRpc = bitcoinRpc;
    }

    private state: HedgingPluginState;

    async loadState() {
        try {
            const data = await fs.readFile("storage/"+STATE_FILENAME);
            this.state = JSON.parse(data.toString(), (key: string, value: any) => {
                if(key==="amountOut" || key==="amountIn" || key==="withdrawalFee") {
                    return new BN(value, 16);
                }
                return value;
            });
            console.log("[Hedging plugin] loaded state: ", this.state);
        } catch (e) {}
    }

    async saveState() {
        const stringified = JSON.stringify(this.state, (key: string, value: any) => {
            if(key==="amountOut" || key==="amountIn" || key==="withdrawalFee") {
                return (value as BN).toString(10);
            }
            return value;
        });
        //console.log("[Hedging plugin] Save state: ", this.state);
        await fs.writeFile("storage/"+STATE_FILENAME, stringified);
    }

    async check() {
        if(this.state==null) return;

        if(this.state.cooldown>Date.now()) return;

        if(this.state.state===RebalancingState.RETRYING) {
            if(this.state.retryAt<Date.now()) {
                await this.setState(this.state.retryState);
            }
            return;
        }

        if(this.state.state===RebalancingState.TRIGGERED) {
            if(this.state.srcToken==="BTC" || this.state.srcToken==="BTC-LN") {
                //Send directly to exchange
                const destinationAddress = await this.okxV5Api.getDepositAddress(this.state.srcToken, null, this.state.amountOut);
                console.log("[Rebalancing plugin: TRIGGERED] Destination address: ", destinationAddress);
                if(this.state.srcToken==="BTC-LN") {
                    //LN
                    const decodedPR = bolt11.decode(destinationAddress);
                    this.state.outTxs = {[decodedPR.tagsObject.payment_hash]: destinationAddress};
                    this.state.cooldown = Date.now()+(5*1000);
                    await this.setState(RebalancingState.OUT_TX);
                    const payment = await lncli.pay({
                        pr: destinationAddress,
                        lnd: this.lnd
                    }).catch(e => {
                        console.error(e);
                    });
                    if(payment==null) {
                        console.log("[Rebalancing plugin: OUT_TX] LN payment error");
                        await this.setState(RebalancingState.IDLE);
                    }
                } else {
                    //On-chain
                    let fundPsbtResponse;
                    try {
                        fundPsbtResponse = await lncli.fundPsbt({
                            lnd: this.lnd,
                            outputs: [
                                {
                                    address: destinationAddress,
                                    tokens: this.state.amountOut.toNumber()
                                }
                            ],
                            target_confirmations: 0,
                            min_confirmations: 0 //TODO: This might not be the best idea
                        });
                    } catch (e) {
                        console.error(e);
                    }

                    if(fundPsbtResponse==null) {
                        console.log("[Rebalancing plugin: TRIGGERED] BTC payment error: fundPsbt");
                        await this.setState(RebalancingState.IDLE);
                        return;
                    }

                    const unlockUtxos = async() => {
                        for(let input of fundPsbtResponse.inputs) {
                            await lncli.unlockUtxo({
                                lnd: this.lnd,
                                id: input.lock_id,
                                transaction_id: input.transaction_id,
                                transaction_vout: input.transaction_vout
                            });
                        }
                    };

                    let signedPsbt;
                    try {
                        signedPsbt = await lncli.signPsbt({
                            lnd: this.lnd,
                            psbt: fundPsbtResponse.psbt
                        });
                    } catch (e) {
                        console.error(e);
                    }

                    if(signedPsbt==null) {
                        await unlockUtxos();
                        console.log("[Rebalancing plugin: TRIGGERED] BTC payment error: signPsbt");
                        await this.setState(RebalancingState.IDLE);
                        return;
                    }

                    const tx = bitcoin.Transaction.fromHex(signedPsbt.transaction);
                    const txId = tx.getId();

                    this.state.cooldown = Date.now()+(5*1000);
                    this.state.outTxs = {[txId]: signedPsbt.transaction};
                    await this.setState(RebalancingState.OUT_TX);

                    let txSendResult;
                    try {
                        txSendResult = await lncli.broadcastChainTransaction({
                            lnd: this.lnd,
                            transaction: signedPsbt.transaction
                        });
                    } catch (e) {
                        console.error(e);
                    }

                    if(txSendResult==null) {
                        await unlockUtxos();
                        console.log("[Rebalancing plugin: OUT_TX] BTC payment error: broadcastChainTransaction");
                        await this.setState(RebalancingState.IDLE);
                        return;
                    }
                }
            } else {
                //Withdraw from SC first
                const withdrawTxs = await this.swapContract.txsWithdraw(this.state.srcTokenAddress, this.state.amountOut);
                this.state.scWithdrawTxs = {};
                await this.swapContract.sendAndConfirm(withdrawTxs, false, null, false, async (txId: string, rawTx: string) => {
                    //Save the rawTx
                    this.state.scWithdrawTxs[txId] = rawTx;
                    this.state.cooldown = Date.now()+(5*1000);
                    await this.setState(RebalancingState.SC_WITHDRAWING);
                });
            }
            return;
        }

        if(this.state.state===RebalancingState.SC_WITHDRAWING) {
            let isSomePending: boolean = false;
            let isNotFoundOrReverted: boolean = false;
            console.log("[Rebalancing plugin: SC_WITHDRAWING] Checking txIds: ", Object.keys(this.state.scWithdrawTxs));
            for(let txId in this.state.scWithdrawTxs) {
                const txData = this.state.scWithdrawTxs[txId];
                const result = await this.swapContract.getTxStatus(txData);
                switch(result) {
                    case "not_found":
                        isNotFoundOrReverted = true;
                        break;
                    case "pending":
                        isSomePending = true;
                        break;
                    case "reverted":
                        isNotFoundOrReverted = true;
                        break;
                    case "success":
                        this.state.scWithdrawTxId = txId;
                        await this.setState(RebalancingState.SC_WITHDRAWAL_CONFIRMED);
                        return;
                }
            }

            if(isNotFoundOrReverted && !isSomePending) {
                this.state.scWithdrawTxs = {};
                await this.setState(RebalancingState.IDLE);
            }
            return;
        }

        if(this.state.state===RebalancingState.SC_WITHDRAWAL_CONFIRMED) {
            const destinationAddress = await this.okxV5Api.getDepositAddress(this.state.srcToken, this.okxSmartChainName);
            console.log("[Rebalancing plugin: SC_WITHDRAWAL_CONFIRMED] Destination address: ", destinationAddress);
            const transferTxs = await this.swapContract.txsTransfer(this.state.srcTokenAddress, this.state.amountOut, destinationAddress);
            this.state.outTxs = {};
            await this.swapContract.sendAndConfirm(transferTxs, false, null, false, async (txId: string, rawTx: string) => {
                //Save the rawTx
                this.state.outTxs[txId] = rawTx;
                this.state.cooldown = Date.now()+(5*1000);
                await this.setState(RebalancingState.OUT_TX);
            });
            return;
        }

        if(this.state.state===RebalancingState.OUT_TX) {
            console.log("[Rebalancing plugin: OUT_TX] Checking txIds: ", Object.keys(this.state.outTxs));
            if(this.state.srcToken==="BTC") {
                const txId = Object.keys(this.state.outTxs)[0];

                const tx = await this.bitcoinRpc.getTransaction(txId);

                if(tx==null) {
                    console.log("[Hedging plugin: OUT_TX] BTC on-chain payment not found!");
                    await this.setState(RebalancingState.IDLE);
                    return;
                }

                //TODO: Maybe use multiple block confirmation
                if(tx.confirmations>=1) {
                    this.state.outTxId = txId;
                    await this.setState(RebalancingState.OUT_TX_CONFIRMED);
                }
            } else if(this.state.srcToken==="BTC-LN") {
                const txId = Object.keys(this.state.outTxs)[0];

                const result = await lncli.getPayment({
                    lnd: this.lnd,
                    id: txId
                }).catch(e => {
                    console.error(e);
                });

                const paymentExists = result!=null;

                if(!paymentExists || result.is_failed) {
                    console.log("[Hedging plugin: OUT_TX] LN payment failed or not found!")
                    await this.setState(RebalancingState.IDLE);
                    return;
                }

                if(result.is_confirmed) {
                    this.state.outTxId = txId;
                    await this.setState(RebalancingState.OUT_TX_CONFIRMED);
                    return;
                }
            } else {
                let isSomePending: boolean = false;
                let isNotFoundOrReverted: boolean = false;
                for(let txId in this.state.outTxs) {
                    const txData = this.state.outTxs[txId];
                    const result = await this.swapContract.getTxStatus(txData);
                    switch(result) {
                        case "not_found":
                            isNotFoundOrReverted = true;
                            break;
                        case "pending":
                            isSomePending = true;
                            break;
                        case "reverted":
                            isNotFoundOrReverted = true;
                            break;
                        case "success":
                            this.state.outTxId = txId;
                            await this.setState(RebalancingState.OUT_TX_CONFIRMED);
                            return;
                    }
                }

                if(isNotFoundOrReverted && !isSomePending) {
                    this.state.outTxs = {};
                    this.state.retryAt = Date.now()+retryTime;
                    this.state.retryState = RebalancingState.SC_WITHDRAWAL_CONFIRMED;
                    await this.setState(RebalancingState.RETRYING);
                }
            }
            return;
        }

        if(this.state.state===RebalancingState.OUT_TX_CONFIRMED) {
            //Check deposit on exchange
            const depositState = await this.okxV5Api.getDeposit(this.state.outTxId);
            if(depositState!=null && (depositState.state==="1" || depositState.state==="2")) {
                this.state.depositId = depositState.depId;
                await this.setState(RebalancingState.DEPOSIT_RECEIVED);
            }
            return;
        }

        if(this.state.state===RebalancingState.DEPOSIT_RECEIVED) {
            const clientOrderId = randomBytes(16).toString("hex");
            this.state.clientOrderId = clientOrderId;
            this.state.cooldown = Date.now()+(5*1000);
            await this.setState(RebalancingState.TRADE_EXECUTING);

            try {
                await this.okxV5Api.marketTrade(this.state.srcToken, this.state.dstToken, this.state.amountOut, clientOrderId);
            } catch (e) {
                console.error(e);
                //TODO: Schedule retry
            }
            return;
        }

        if(this.state.state===RebalancingState.TRADE_EXECUTING) {
            let tradeData;
            try {
                tradeData = await this.okxV5Api.getTrade(this.state.srcToken, this.state.dstToken, this.state.clientOrderId);
            } catch (e) {
                if(e instanceof OKXError) {
                    const isOrderNotFound = e.errorCode==="52907" || e.errorCode==="51603";
                    if(isOrderNotFound) {
                        console.log("[Hedging plugin: TRADE_EXECUTING] Trade not found!");
                        this.state.retryAt = Date.now()+retryTime;
                        this.state.retryState = RebalancingState.DEPOSIT_RECEIVED;
                        await this.setState(RebalancingState.RETRYING);
                    }
                }
                console.error(e);
                return;
            }

            if(tradeData.state==="canceled" || tradeData.state==="mmp_canceled") {
                this.state.retryAt = Date.now()+retryTime;
                this.state.retryState = RebalancingState.DEPOSIT_RECEIVED;
                await this.setState(RebalancingState.RETRYING);
                return;
            }

            if(tradeData.state==="filled") {
                this.state.orderId = tradeData.orderId;
                this.state.price = tradeData.averagePrice;
                this.state.amountIn = await this.okxV5Api.getBalance(this.state.dstToken);
                await this.setState(RebalancingState.TRADE_EXECUTED);
                return;
            }
        }

        if(this.state.state===RebalancingState.TRADE_EXECUTED) {
            const transferId = randomBytes(16).toString("hex");
            this.state.clientTransferId = transferId;
            this.state.cooldown = Date.now() + (5*1000);
            await this.setState(RebalancingState.FUNDS_TRANSFERING)
            try {
                await this.okxV5Api.fundsTransfer(this.state.dstToken, "trading", "funding", this.state.amountIn, transferId);
            } catch (e) {}
            return;
        }

        if(this.state.state===RebalancingState.FUNDS_TRANSFERING) {
            try {
                const resp = await this.okxV5Api.getFundsTransfer(this.state.clientTransferId);
                if(resp==null || resp.state==="failed") {
                    this.state.retryAt = Date.now() + retryTime;
                    this.state.retryState = RebalancingState.TRADE_EXECUTED;
                    await this.setState(RebalancingState.RETRYING);
                    return;
                }
                if(resp.state==="success") {
                    this.state.transferId = resp.transId;
                    await this.setState(RebalancingState.FUNDS_TRANSFERED)
                }
            } catch (e) {
                console.error(e);
            }
            return;
        }

        if(this.state.state===RebalancingState.FUNDS_TRANSFERED) {
            this.state.withdrawalFee = await this.okxV5Api.getWithdrawalFee(this.state.dstToken, this.okxSmartChainName, this.state.amountIn);
            if(this.state.dstToken==="BTC") {
                const resp = await lncli.getChainAddresses({
                    lnd: this.lnd
                });

                const addrObj = resp.addresses.find(addr => !addr.is_change);

                this.state.receivingAddress = addrObj.address;
            } else if(this.state.dstToken==="BTC-LN") {
                const {request} = await lncli.createInvoice({
                    lnd: this.lnd,
                    mtokens: this.state.amountIn.sub(this.state.withdrawalFee).mul(new BN(1000)).toString(10)
                });
                this.state.receivingAddress = request;
            } else {
                this.state.receivingAddress = this.swapContract.getAddress();
            }
            const withdrawalId = randomBytes(16).toString("hex");
            this.state.withdrawalId = withdrawalId;
            this.state.cooldown = Date.now() + (5*1000);
            await this.setState(RebalancingState.WITHDRAWING);

            try {
                await this.okxV5Api.withdraw(this.state.dstToken, this.okxSmartChainName, this.state.receivingAddress, withdrawalId, this.state.withdrawalFee, this.state.amountIn.sub(this.state.withdrawalFee));
            } catch (e) {
                if(e instanceof OKXError) {
                    this.state.retryAt = Date.now() + retryTime;
                    this.state.retryState = RebalancingState.FUNDS_TRANSFERED;
                    await this.setState(RebalancingState.RETRYING);
                }
                console.error(e);
            }
            return;
        }

        if(this.state.state===RebalancingState.WITHDRAWING) {
            const withdrawal = await this.okxV5Api.getWithdrawal(this.state.withdrawalId);
            if(withdrawal==null) {
                this.state.retryAt = Date.now()+retryTime;
                this.state.retryState = RebalancingState.FUNDS_TRANSFERED;
                await this.setState(RebalancingState.RETRYING);
                return;
            }
            if(withdrawal.state==="-3" || withdrawal.state==="-2" || withdrawal.state==="-1") {
                this.state.retryAt = Date.now()+retryTime;
                this.state.retryState = RebalancingState.FUNDS_TRANSFERED;
                await this.setState(RebalancingState.RETRYING);
                return;
            }
            if(withdrawal.state==="2") {
                this.state.inTxId = withdrawal.txId;
                await this.setState(RebalancingState.WITHDRAWAL_SENT);
            }
            return;
        }

        if(this.state.state===RebalancingState.WITHDRAWAL_SENT) {
            //Check if incoming transaction is confirmed
            if(this.state.dstToken==="BTC") {
                const tx = await this.bitcoinRpc.getTransaction(this.state.inTxId);

                if(tx==null) {
                    console.log("[Hedging plugin: WITHDRAWAL_SENT] BTC on-chain payment not found!");
                    this.state.retryAt = Date.now()+retryTime;
                    this.state.retryState = RebalancingState.WITHDRAWING;
                    await this.setState(RebalancingState.RETRYING);
                    return;
                }

                //TODO: Maybe use multiple block confirmation
                if(tx.confirmations>=1) {
                    await this.setState(RebalancingState.IN_TX_CONFIRMED);
                }
            } else if(this.state.dstToken==="BTC-LN") {
                const invoice = await lncli.getInvoice({
                    id: this.state.inTxId,
                    lnd: this.lnd
                });

                if(invoice.is_confirmed) {
                    await this.setState(RebalancingState.IN_TX_CONFIRMED);
                }
                if(invoice.is_canceled) {
                    this.state.retryAt = Date.now()+retryTime;
                    this.state.retryState = RebalancingState.WITHDRAWING;
                    await this.setState(RebalancingState.RETRYING);
                }
            } else {
                const result = await this.swapContract.getTxIdStatus(this.state.inTxId);
                if(result==="success") {
                    await this.setState(RebalancingState.IN_TX_CONFIRMED);
                }
                if(result==="reverted") {
                    this.state.retryAt = Date.now()+retryTime;
                    this.state.retryState = RebalancingState.WITHDRAWING;
                    await this.setState(RebalancingState.RETRYING);
                }
            }
            return;
        }

        if(this.state.state===RebalancingState.IN_TX_CONFIRMED) {
            if(this.state.dstToken!=="BTC" && this.state.dstToken!=="BTC-LN") {
                //Deposit back to SC
                const depositTxs = await this.swapContract.txsDeposit(this.state.dstTokenAddress, this.state.amountIn.sub(this.state.withdrawalFee));
                this.state.scDepositTxs = {};
                await this.swapContract.sendAndConfirm(depositTxs, false, null, false, async (txId: string, rawTx: string) => {
                    //Save the rawTx
                    this.state.scDepositTxs[txId] = rawTx;
                    this.state.cooldown = Date.now()+(5*1000);
                    await this.setState(RebalancingState.SC_DEPOSITING);
                });
            } else {
                await this.setState(RebalancingState.FINISHED);
                return;
            }
        }

        if(this.state.state===RebalancingState.SC_DEPOSITING) {
            let isSomePending: boolean = false;
            let isNotFoundOrReverted: boolean = false;
            for(let txId in this.state.scDepositTxs) {
                const txData = this.state.scDepositTxs[txId];
                const result = await this.swapContract.getTxStatus(txData);
                switch(result) {
                    case "not_found":
                        isNotFoundOrReverted = true;
                        break;
                    case "pending":
                        isSomePending = true;
                        break;
                    case "reverted":
                        isNotFoundOrReverted = true;
                        break;
                    case "success":
                        this.state.scDepositTxId = txId;
                        await this.setState(RebalancingState.SC_DEPOSITED);
                        return;
                }
            }

            if(isNotFoundOrReverted && !isSomePending) {
                this.state.retryAt = Date.now()+retryTime;
                this.state.retryState = RebalancingState.IN_TX_CONFIRMED;
                await this.setState(RebalancingState.RETRYING);
            }
            return;
        }

        if(this.state.state===RebalancingState.SC_DEPOSITED) {
            await this.setState(RebalancingState.FINISHED);
        }
    }

    async setState(newState: RebalancingState) {
        for(let requiredField of REQUIRED_FIELDS[newState]) {
            if(this.state[requiredField]==null) throw new Error("Invalid state transition, missing field: "+requiredField);
        }

        const oldState = this.state.state;
        this.state.state = newState;
        await this.saveState();

        console.log("[Hedging plugin: State transition] "+oldState+" -> "+newState);

        await this.check();
    }

    async runSwapStateChecker() {
        let func;
        func = async () => {
            try {
                await this.check();
            } catch (e) {
                console.error(e);
            }
            setTimeout(func, checkInterval);
        };
        await func();
    }

    async onEnable(
        swapContract: SwapContract<T, any>,
        btcRelay: BtcRelay<any, any, any>,
        chainEvents: ChainEvents<T>,
        lnd: AuthenticatedLnd
    ): Promise<void> {
        this.swapContract = swapContract;
        this.lnd = lnd;

        await this.loadState();

        this.swapContract.onBeforeTxReplace(async (oldTx: string, oldTxId: string, newTx: string, newTxId: string)=> {
            if(this.state.state===RebalancingState.SC_WITHDRAWING) {
                if(this.state.scWithdrawTxs[oldTxId]!=null) {
                    this.state.scWithdrawTxs[newTxId] = newTx;
                    this.state.cooldown = Date.now()+(5*1000);
                    await this.saveState();
                }
            }
            if(this.state.state===RebalancingState.OUT_TX) {
                if(this.state.outTxs[oldTxId]!=null) {
                    this.state.outTxs[newTxId] = newTx;
                    this.state.cooldown = Date.now()+(5*1000);
                    await this.saveState();
                }
            }
            if(this.state.state===RebalancingState.SC_DEPOSITING) {
                if(this.state.scDepositTxs[oldTxId]!=null) {
                    this.state.scDepositTxs[newTxId] = newTx;
                    this.state.cooldown = Date.now()+(5*1000);
                    await this.saveState();
                }
            }
        });

        this.okxV5Api = new OKX('https://www.okx.com',this.apiKey,this.apiSecret,this.apiPassword);

        const resp = await lncli.getChainAddresses({
            lnd: this.lnd
        });

        const addrObj = resp.addresses.find(addr => !addr.is_change);

        console.log("To be whitelisted BTC chain address: ", addrObj.address);
        console.log("To be whitelisted smart chain address: ", this.swapContract.getAddress());

        this.btcDepositAddress = addrObj.address;

        await this.runSwapStateChecker();

        //await this.saveState();

        // this.state = {state: null};
        // this.state.srcToken = "USDC";
        // this.state.srcTokenAddress = this.tokenAddresses["USDC"];
        // this.state.dstToken = "BTC";
        // this.state.dstTokenAddress = "";
        // this.state.amountOut = new BN("35000000000000000000");
        // await this.setState(RebalancingState.TRIGGERED);

        // const apiResult = await okxV5Api.call({
        //     method: 'POST',
        //     path: '/api/v5/asset/withdrawal-lightning',
        //     data: {
        //         ccy: "BTC",
        //         invoice: "lnbc50u1pj2d6qrpp55qqr5cet4rqskxl8enwca2xql45zlduhnkfjdventsxuf0k3n87qhp52r2anlhddfa9ex9vpw9gstxujff8a0p8s3pzvua930js0kwfea6scqzzsxqyz5vqsp5apq5qvmdleu97sestsfva2fnzwgyym2uxjflsmrque5l6dgl4cwq9qyyssq9w5wcl3eqns7tcgh6xsmf6va46h892e7j36s59f8mtz27lh3mtw8ny85g5fyyrtjd2sm3levw356flhgyddm6ecyfqm0448m7k032rgpa8c4al"
        //     }ou
        // });

        // const apiResult = await okxV5Api.call({
        //     method: 'POST',
        //     path: '/api/v5/asset/transfer',
        //     data: {
        //         ccy: "BTC",
        //         amt: "0.00005",
        //         from: "18",
        //         to: "6"
        //     }
        // });

        // const orderId = randomBytes(16).toString("hex");
        // const apiResult = await this.okxV5Api.getWithdrawalFee("USDC", "Polygon", new BN(10000000));
        //
        // console.log("order id: ", orderId);
        // console.log("apiResult: ", apiResult);

        // setInterval(async () => {
        //
        //     const balanceUSDC = await swapContract.getBalance(swapContract.toTokenAddress(this.tokenAddresses.USDC), true);
        //     const balanceUSDCinBTC = await this.swapPricing.getToBtcSwapAmount(balanceUSDC, swapContract.toTokenAddress(this.tokenAddresses.USDC));
        //
        //     const channelBalances = await lncli.getChannelBalance({lnd});
        //     const balanceLightning = new BN(channelBalances.channel_balance_mtokens).div(new BN(1000));
        //
        //     const onchainBalances = await lncli.getChainBalance({lnd});
        //     const balanceOnchain = new BN(onchainBalances.chain_balance);
        //
        //     console.log("Balance USDC: ", balanceUSDC.toString());
        //     console.log("Balance USDC in BTC: ", balanceUSDCinBTC.toString());
        //     console.log("Balance BTC-LN: ", balanceLightning.toString());
        //     console.log("Balance BTC: ", balanceOnchain.toString());
        //
        //     const lockedBalances: Record<string, BN> = {}; //Balances locked in PTLCs and HTLCs
        //     const returningBalances: Record<string, BN> = {}; //Balances that are just being refunded back to us
        //
        //     if(this.fromBtcLn!=null) {
        //         for(let swapHash in this.fromBtcLn.storageManager.data) {
        //             const swap = this.fromBtcLn.storageManager.data[swapHash];
        //             if(swap.state===FromBtcLnSwapState.COMMITED) {
        //                 if(lockedBalances[swap.data.getToken().toString()]==null) {
        //                     lockedBalances[swap.data.getToken().toString()] = swap.data.getAmount();
        //                 } else {
        //                     lockedBalances[swap.data.getToken().toString()] = lockedBalances[swap.data.getToken().toString()].add(swap.data.getAmount());
        //                 }
        //             }
        //             if(swap.state===FromBtcLnSwapState.CANCELED && swap.data!=null) {
        //                 if(returningBalances[swap.data.getToken().toString()]==null) {
        //                     returningBalances[swap.data.getToken().toString()] = swap.data.getAmount();
        //                 } else {
        //                     returningBalances[swap.data.getToken().toString()] = returningBalances[swap.data.getToken().toString()].add(swap.data.getAmount());
        //                 }
        //             }
        //         }
        //     }
        //
        //     if(this.fromBtc!=null) {
        //         for(let swapHash in this.fromBtc.storageManager.data) {
        //             const swap = this.fromBtc.storageManager.data[swapHash];
        //             if(swap.state===FromBtcSwapState.COMMITED) {
        //                 if(lockedBalances[swap.data.getToken().toString()]==null) {
        //                     lockedBalances[swap.data.getToken().toString()] = swap.data.getAmount();
        //                 } else {
        //                     lockedBalances[swap.data.getToken().toString()] = lockedBalances[swap.data.getToken().toString()].add(swap.data.getAmount());
        //                 }
        //             }
        //         }
        //     }
        //
        //     console.log("Locked balances: ", lockedBalances);
        //     console.log("Returning balances: ", returningBalances);
        //
        // }, 15000);

    }

    onDisable(): Promise<void> {
        return Promise.resolve();
    }

    async onServiceInitialize(service: SwapHandler<SwapHandlerSwap<T>, T>): Promise<void> {
        if(service instanceof FromBtcLnAbs) this.fromBtcLn = service;
        if(service instanceof FromBtcAbs) this.fromBtc = service;
    }

    onSwapStateChange(swap: SwapHandlerSwap<T>): Promise<void> {
        return Promise.resolve();
    }

}