/**
 * 1 — Normal payment, internalized before it is confirmed (BRC-29 + 'wallet payment').
 *
 * The sender here is NOT a wallet. It is a bare private key using @bsv/sdk, the way a
 * paying service would be. The receiver is a BRC-100 wallet.
 *
 * The payment transaction is never broadcast. It has no merkle proof and cannot have one.
 * The wallet takes custody of it anyway, because BEEF only requires proofs for MINED
 * ANCESTORS — never for the transaction being handed over.
 */

import {
  WalletClient,
  PrivateKey,
  KeyDeriver,
  Transaction,
  P2PKH,
  Utils,
  Random,
  WhatsOnChainBroadcaster,
  type WalletProtocol
} from '@bsv/sdk'

// BRC-29: security level 2, protocol name '3241645161d8'. The receiving wallet uses this
// exact pair internally, so it must match byte-for-byte or the derived keys won't agree.
const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

const wallet = new WalletClient('auto', 'localhost')

// Follow whatever chain the wallet is on, rather than assuming. On mainnet this
// spends real satoshis.
const { network } = await wallet.getNetwork({})
const broadcaster = new WhatsOnChainBroadcaster(network === 'mainnet' ? 'main' : 'test')

// ── Receiver identity ────────────────────────────────────────────────────────
// The sender needs this to derive the payment key. It is public information.
const { publicKey: receiverIdentityKey } = await wallet.getPublicKey({ identityKey: true })

// ── Sender ───────────────────────────────────────────────────────────────────
const senderPriv = PrivateKey.fromRandom()
const senderIdentityKey = senderPriv.toPublicKey().toString()

// Opaque to the counterparty — they only ever concatenate them into the keyID.
const derivationPrefix = Utils.toBase64(Random(16))
const derivationSuffix = Utils.toBase64(Random(16))

// Fund the sender from the wallet. createAction hands back the funding tx as Atomic BEEF
// with its ancestry already proven, which is exactly what the sender needs to build on.
// randomizeOutputs defaults to TRUE — without this, outputIndex 0 is not guaranteed.
const senderAddress = senderPriv.toPublicKey().toAddress()
const { tx: fundingBeef, txid: fundingTxid } = await wallet.createAction({
  description: 'Fund the sender key',
  outputs: [
    {
      lockingScript: new P2PKH().lock(senderAddress).toHex(),
      satoshis: 5000,
      outputDescription: 'sender coin'
    }
  ],
  // acceptDelayedBroadcast defaults to TRUE, which makes createAction return before the
  // funding tx has reached the network. The payment below spends it right away, so it
  // must genuinely be out there first — otherwise the broadcast fails: 'Missing inputs'.
  options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
})

const fundingTx = Transaction.fromAtomicBEEF(fundingBeef!)

// Derive the receiver's payment key. forSelf: false means "derive THEIR key, not mine".
// The receiver's wallet performs the mirror-image derivation with the same shared secret,
// which is why senderIdentityKey is a required field in the remittance below.
const keyID = `${derivationPrefix} ${derivationSuffix}`
const paymentPub = new KeyDeriver(senderPriv).derivePublicKey(
  BRC29_PROTOCOL,
  keyID,
  receiverIdentityKey,
  false
)

const paymentTx = new Transaction()
paymentTx.addInput({
  sourceTransaction: fundingTx,
  sourceOutputIndex: 0,
  unlockingScriptTemplate: new P2PKH().unlock(senderPriv)
})
paymentTx.addOutput({
  lockingScript: new P2PKH().lock(paymentPub.toAddress()),
  satoshis: 1000
})
// Let fee() size the fee and return the remainder, rather than burning it.
paymentTx.addOutput({ lockingScript: new P2PKH().lock(senderAddress), change: true })
await paymentTx.fee()
await paymentTx.sign()

// Not broadcast. At this moment the transaction exists only in memory, and no proof
// for it exists anywhere. That is the state the wallet is about to accept it in.
const atomicBeef = paymentTx.toAtomicBEEF()

// ── Receiver ─────────────────────────────────────────────────────────────────
const txid = paymentTx.id('hex')

// listActions filters by label only — it has no txid filter and no ordering guarantee.
// So label this run uniquely, or you end up reading some earlier run's action and
// drawing conclusions from it.
const runLabel = `demo-${txid.slice(0, 16)}`

const result = await wallet.internalizeAction({
  tx: atomicBeef,
  outputs: [
    {
      outputIndex: 0,
      protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
    }
  ],
  description: 'Receive unconfirmed payment',
  labels: ['buzzmint-demo', runLabel]
})

console.log('1. internalized:', result.accepted, '— network has not seen this tx yet')

const before = await wallet.listActions({ labels: [runLabel], limit: 1 })
console.log('   status:', before.actions[0]?.status, '— the coins are already yours')

// ── Only now does it touch the chain ─────────────────────────────────────────
// Custody happened first. Broadcasting is a separate, later event — and confirmation
// is later still. The wallet Monitor will attach the merkle proof when the block lands,
// moving this action to 'completed' on its own.
// Always check this. A broadcast can be rejected, and a rejected transaction never
// confirms — the wallet will eventually drop the output you thought you held.
const bc = await paymentTx.broadcast(broadcaster)
if (bc.status === 'error') throw new Error(`broadcast rejected: ${bc.description}`)
console.log('2. broadcast:', txid)
console.log('   funding txid:', fundingTxid)
const woc = network === 'mainnet' ? 'whatsonchain.com' : 'test.whatsonchain.com'
console.log('   view:', `https://${woc}/tx/${txid}`)
