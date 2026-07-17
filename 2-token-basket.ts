/**
 * 2 — A real 1Sat Ordinal, internalized into a basket while still unconfirmed.
 *
 * This is a genuine 1Sat Ordinal: one satoshi, a real inscription envelope
 *
 *     OP_FALSE OP_IF "ord" OP_1 <content-type> OP_0 <content> OP_ENDIF <P2PKH lock>
 *
 * plus MAP metadata in an OP_RETURN. Any ordinals indexer will recognise it.
 *
 * Two things worth understanding:
 *
 *   1. The wallet does not parse the script. It has no idea what an ordinal is.
 *      'basket insertion' means "hold this UTXO under this name" — that is the whole
 *      contract. The inscription is meaningful to indexers and to you, not to the wallet.
 *
 *   2. It is inscribed to a key the WALLET derives, so the ordinal is genuinely yours
 *      and genuinely spendable later. customInstructions records the protocol and keyID
 *      needed to re-derive it — without that, custody of the coin is worthless.
 *
 * Order of events: broadcast → internalize with no proof → the proof arrives later.
 */

import {
  WalletClient,
  PrivateKey,
  PublicKey,
  Transaction,
  P2PKH,
  LockingScript,
  Utils,
  WhatsOnChainBroadcaster,
  type WalletProtocol
} from '@bsv/sdk'

const BASKET = 'demo-buzzmint-ordinals'

// How the wallet derives the ordinal's key. Recorded in customInstructions below so the
// holder can re-derive it to spend. This mirrors what real integrations do.
const ORD_PROTOCOL: WalletProtocol = [1, 'buzzmint ordinal']
const ORD_KEY_ID = '1'

const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const hex = (s: string): string => Utils.toHex(Utils.toArray(s, 'utf8'))

const wallet = new WalletClient('auto', 'localhost')

// Follow whatever chain the wallet is on, rather than assuming. On mainnet this
// spends real satoshis.
const { network } = await wallet.getNetwork({})
const broadcaster = new WhatsOnChainBroadcaster(network === 'mainnet' ? 'main' : 'test')

// ── Inscribe to a key the wallet controls ────────────────────────────────────
const { publicKey: ordPubKey } = await wallet.getPublicKey({
  protocolID: ORD_PROTOCOL,
  keyID: ORD_KEY_ID,
  counterparty: 'self'
})
const ordAddress = PublicKey.fromString(ordPubKey).toAddress()

// A real inscription. SVG so it actually renders in ordinal explorers.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#111"/><text x="50" y="56" font-family="monospace" font-size="13" fill="#f5c518" text-anchor="middle">buzzmint</text></svg>`
const inscription = { contentType: 'image/svg+xml', dataB64: Buffer.from(svg).toString('base64') }
const meta = { app: 'buzzmint', type: 'ord', name: 'buzzmint demo ordinal' }

// Envelope first, then the lock — this ordering is what makes it a 1Sat Ordinal.
const envelope = `OP_FALSE OP_IF ${hex('ord')} OP_1 ${hex(inscription.contentType)} OP_0 ${Buffer.from(inscription.dataB64, 'base64').toString('hex')} OP_ENDIF`
const mapAsm = Object.entries(meta)
  .map(([k, v]) => `${hex(k)} ${hex(v)}`)
  .join(' ')
const ordinalScript = LockingScript.fromASM(
  `${envelope} ${new P2PKH().lock(ordAddress).toASM()} OP_RETURN ${hex(MAP_PREFIX)} ${hex('SET')} ${mapAsm}`
)

// ── Sender ───────────────────────────────────────────────────────────────────
const senderPriv = PrivateKey.fromRandom()
const senderAddress = senderPriv.toPublicKey().toAddress()

const { tx: fundingBeef } = await wallet.createAction({
  description: 'Fund the inscriber',
  outputs: [
    {
      lockingScript: new P2PKH().lock(senderAddress).toHex(),
      satoshis: 3000,
      outputDescription: 'inscriber coin'
    }
  ],
  // acceptDelayedBroadcast defaults to TRUE, which makes createAction return before the
  // funding tx has reached the network. The ordinal below spends it right away, so it
  // must genuinely be out there first — otherwise the broadcast fails: 'Missing inputs'.
  options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
})

const ordTx = new Transaction()
ordTx.addInput({
  sourceTransaction: Transaction.fromAtomicBEEF(fundingBeef!),
  sourceOutputIndex: 0,
  unlockingScriptTemplate: new P2PKH().unlock(senderPriv)
})
// The ordinal itself: exactly one satoshi. That is the standard, not a shortcut.
ordTx.addOutput({ lockingScript: ordinalScript, satoshis: 1 })
ordTx.addOutput({ lockingScript: new P2PKH().lock(senderAddress), change: true })
await ordTx.fee()
await ordTx.sign()

const txid = ordTx.id('hex')

// ── Broadcast first, internalize second ──────────────────────────────────────
// The wallet would accept this before broadcast — BEEF proves validity without a merkle
// proof. But an output whose transaction no miner has accepted can still be taken away
// by a conflicting spend of the same inputs, and if nobody ever broadcasts it, it just
// quietly dies. Get it accepted, then take custody. See 1-payment.ts for why this
// ordering matters much more when there is a counterparty involved.
const bc = await ordTx.broadcast(broadcaster)
if (bc.status === 'error') throw new Error(`broadcast rejected: ${bc.description}`)
console.log('1. broadcast:', txid, '— accepted by a miner')

// ── Receiver: take custody while it is still unmined ─────────────────────────
// Accepted but not in a block: no merkle proof exists, and none can yet.
const atomicBeef = ordTx.toAtomicBEEF()

// listActions filters by label only — it has no txid filter and no ordering guarantee.
// So label this run uniquely, or you end up reading some earlier run's action and
// drawing conclusions from it.
const runLabel = `demo-${txid.slice(0, 16)}`

const result = await wallet.internalizeAction({
  tx: atomicBeef,
  outputs: [
    {
      outputIndex: 0,
      protocol: 'basket insertion',
      insertionRemittance: {
        basket: BASKET,
        tags: ['ord', `app:${meta.app}`, `contentType:${inscription.contentType}`],
        // Stored verbatim, returned by listOutputs. The keyID is the load-bearing part:
        // it is how you re-derive the key to spend this ordinal later.
        customInstructions: JSON.stringify({
          protocolID: ORD_PROTOCOL,
          keyID: ORD_KEY_ID,
          counterparty: 'self',
          contentType: inscription.contentType,
          ...meta
        })
      }
    }
  ],
  description: 'Receive unconfirmed ordinal',
  labels: ['buzzmint-demo', runLabel]
})

console.log('2. internalized:', result.accepted, '— no merkle proof exists for this tx')

const after = await wallet.listActions({ labels: [runLabel], limit: 1 })
console.log('   status:', after.actions[0]?.status, '— held, unconfirmed')

const { outputs } = await wallet.listOutputs({
  basket: BASKET,
  tags: ['ord'],
  includeCustomInstructions: true,
  includeTags: true
})
const mine = outputs.find(o => o.outpoint === `${txid}.0`)
console.log('3. in basket:', mine?.outpoint, `(${mine?.satoshis} sat)`)
const woc = network === 'mainnet' ? 'whatsonchain.com' : 'test.whatsonchain.com'
console.log('   view:', `https://${woc}/tx/${txid}`)
// 1satordinals.com indexes mainnet only.
if (network === 'mainnet') console.log('   ordinal:', `https://1satordinals.com/outpoint/${txid}_0`)
console.log('\n   Re-run listActions in a few minutes: unproven -> completed,')
console.log('   once the wallet Monitor attaches the merkle proof.')
