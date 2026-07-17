/**
 * 3 — Certificates. Two different things share this word, and mixing them up wastes days.
 *
 *   (a) A certificate TOKEN — a real 1Sat Ordinal whose inscription IS the signed claim.
 *       It is a UTXO. It goes into a basket with 'basket insertion' while still
 *       unconfirmed, exactly like the ordinal in example 2. The wallet holds a coin it
 *       cannot read.
 *
 *   (b) A BRC-52 identity certificate — a signed set of fields about a subject, issued by
 *       a certifier. It is NOT a UTXO. It has no output, no basket, and no confirmation
 *       state, because it is not on chain at all. It arrives via acquireCertificate.
 *
 * Pick (b) for selective field disclosure and verifiable issuer signatures.
 * Pick (a) when the credential must be a transferable, publicly-auditable coin.
 *
 * Both are shown below, in that order.
 */

import {
  WalletClient,
  PrivateKey,
  PublicKey,
  ProtoWallet,
  MasterCertificate,
  Transaction,
  P2PKH,
  LockingScript,
  Utils,
  Random,
  WhatsOnChainBroadcaster,
  type WalletProtocol
} from '@bsv/sdk'

const BASKET = 'demo-buzzmint-certificates'
const CERT_PROTOCOL: WalletProtocol = [1, 'buzzmint certificate']
const CERT_KEY_ID = '1'

const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const hex = (s: string): string => Utils.toHex(Utils.toArray(s, 'utf8'))

const wallet = new WalletClient('auto', 'localhost')
const { publicKey: subjectIdentityKey } = await wallet.getPublicKey({ identityKey: true })

// Follow whatever chain the wallet is on, rather than assuming. On mainnet this
// spends real satoshis.
const { network } = await wallet.getNetwork({})
const broadcaster = new WhatsOnChainBroadcaster(network === 'mainnet' ? 'main' : 'test')

// ═══════════════════════════════════════════════════════════════════════════
// (a) Certificate as a real 1Sat Ordinal → basket insertion, while unconfirmed
// ═══════════════════════════════════════════════════════════════════════════

// Inscribed to a key the wallet derives, so the credential is genuinely the holder's
// and genuinely spendable. The keyID is recorded in customInstructions below.
const { publicKey: certPubKey } = await wallet.getPublicKey({
  protocolID: CERT_PROTOCOL,
  keyID: CERT_KEY_ID,
  counterparty: 'self'
})
const certAddress = PublicKey.fromString(certPubKey).toAddress()

const issuerPriv = PrivateKey.fromRandom()
const claim = {
  type: 'kyc',
  issuer: 'acme-compliance',
  issuerKey: issuerPriv.toPublicKey().toString(),
  subject: subjectIdentityKey,
  verifiedAt: new Date().toISOString().slice(0, 10)
}

// The issuer signs the claim so anyone can verify provenance from the chain alone.
// The wallet plays no part in this — to it, the script is opaque bytes.
const signature = issuerPriv.sign(Utils.toArray(JSON.stringify(claim), 'utf8')).toDER('hex') as string
const credential = JSON.stringify({ ...claim, signature })

// A real 1Sat Ordinal: envelope first, then the lock. content-type application/json,
// so the inscription is the credential itself and any indexer can read it.
const envelope = `OP_FALSE OP_IF ${hex('ord')} OP_1 ${hex('application/json')} OP_0 ${hex(credential)} OP_ENDIF`
const meta = { app: 'buzzmint', type: 'ord', name: `${claim.issuer} ${claim.type} certificate` }
const mapAsm = Object.entries(meta).map(([k, v]) => `${hex(k)} ${hex(v)}`).join(' ')

const certScript = LockingScript.fromASM(
  `${envelope} ${new P2PKH().lock(certAddress).toASM()} OP_RETURN ${hex(MAP_PREFIX)} ${hex('SET')} ${mapAsm}`
)

const senderPriv = PrivateKey.fromRandom()
const senderAddress = senderPriv.toPublicKey().toAddress()

const { tx: fundingBeef } = await wallet.createAction({
  description: 'Fund the certificate issuer',
  outputs: [
    {
      lockingScript: new P2PKH().lock(senderAddress).toHex(),
      satoshis: 3000,
      outputDescription: 'issuer coin'
    }
  ],
  // acceptDelayedBroadcast defaults to TRUE, which makes createAction return before the
  // funding tx has reached the network. The ordinal below spends it right away, so it
  // must genuinely be out there first — otherwise the broadcast fails: 'Missing inputs'.
  options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
})

const certTx = new Transaction()
certTx.addInput({
  sourceTransaction: Transaction.fromAtomicBEEF(fundingBeef!),
  sourceOutputIndex: 0,
  unlockingScriptTemplate: new P2PKH().unlock(senderPriv)
})
certTx.addOutput({ lockingScript: certScript, satoshis: 1 })
certTx.addOutput({ lockingScript: new P2PKH().lock(senderAddress), change: true })
await certTx.fee()
await certTx.sign()

const certTxid = certTx.id('hex')
console.log('(a) certificate ordinal')

// ── Broadcast first, internalize second ──────────────────────────────────────
// The wallet would accept this before broadcast, but a credential whose transaction no
// miner has accepted is not a credential you hold — the inputs can still be spent out
// from under it. Get it accepted, then take custody. See 1-payment.ts for the full
// reasoning; it matters most where there is a counterparty.
const bc = await certTx.broadcast(broadcaster)
if (bc.status === 'error') throw new Error(`broadcast rejected: ${bc.description}`)
console.log('    1. broadcast:', certTxid, '— accepted by a miner')

// listActions filters by label only — it has no txid filter and no ordering guarantee.
// So label this run uniquely, or you end up reading some earlier run's action and
// drawing conclusions from it.
const runLabel = `demo-${certTxid.slice(0, 16)}`

// Custody while it is still unmined: accepted, but no merkle proof exists yet.
const tokenResult = await wallet.internalizeAction({
  tx: certTx.toAtomicBEEF(),
  outputs: [
    {
      outputIndex: 0,
      protocol: 'basket insertion',
      insertionRemittance: {
        basket: BASKET,
        tags: ['ord', `app:${meta.app}`, `issuer:${claim.issuer}`, `type:${claim.type}`],
        // The keyID is the load-bearing part: it is how the holder re-derives the key
        // to transfer this credential later.
        customInstructions: JSON.stringify({
          protocolID: CERT_PROTOCOL,
          keyID: CERT_KEY_ID,
          counterparty: 'self',
          contentType: 'application/json',
          ...claim
        })
      }
    }
  ],
  description: 'Receive unconfirmed cert',
  labels: ['buzzmint-demo', runLabel]
})

console.log('    2. internalized:', tokenResult.accepted, '— no merkle proof exists yet')

const after = await wallet.listActions({ labels: [runLabel], limit: 1 })
console.log('       status:', after.actions[0]?.status, '— held, unconfirmed')

const { outputs } = await wallet.listOutputs({
  basket: BASKET,
  tags: [`type:${claim.type}`],
  includeCustomInstructions: true,
  includeTags: true
})
const mine = outputs.find(o => o.outpoint === `${certTxid}.0`)
console.log('    3. in basket:', mine?.outpoint, `(${mine?.satoshis} sat)`)
// 1satordinals.com indexes mainnet only.
if (network === 'mainnet') console.log('       ordinal:', `https://1satordinals.com/outpoint/${certTxid}_0`)

// ═══════════════════════════════════════════════════════════════════════════
// (b) A real BRC-52 identity certificate → acquireCertificate
// ═══════════════════════════════════════════════════════════════════════════
//
// Note what is absent: no tx, no outputIndex, no basket, no BEEF, no internalizeAction.
// "Unconfirmed" is not a meaningful state here — there is nothing on chain to confirm.
//
// A certificate is not a blob you can hand-assemble. The wallet checks it: every field
// must be encrypted, the keyring must carry a decryption key for each one, and the
// certifier's signature must verify. issueCertificateForSubject does all of that.
//
// In production the certifier is a remote party and this half runs on their machine; the
// result reaches the subject over BRC-103. Here both sides are in one file to keep it short.

const certifierWallet = new ProtoWallet(PrivateKey.fromRandom())
const certificateType = Utils.toBase64(Random(32))

const master = await MasterCertificate.issueCertificateForSubject(
  certifierWallet,
  subjectIdentityKey,
  { name: 'Ada Lovelace', country: 'CH' },
  certificateType,
  // The outpoint the certifier would spend to revoke. A real certifier tracks a live
  // UTXO here; this demo has nothing to revoke, so it is a placeholder.
  async () => `${'00'.repeat(32)}.0`
)

// fields arrive encrypted; masterKeyring holds the per-field keys, encrypted for the subject.
const certResult = await wallet.acquireCertificate({
  type: master.type,
  certifier: master.certifier,
  acquisitionProtocol: 'direct',
  serialNumber: master.serialNumber,
  fields: master.fields,
  revocationOutpoint: master.revocationOutpoint,
  signature: master.signature!,
  keyringRevealer: 'certifier',
  keyringForSubject: master.masterKeyring
})

console.log('\n(b) identity certificate')
console.log('    acquired:', certResult.serialNumber)
console.log('    no basket, no tx, no confirmation state — not a UTXO')

const { certificates } = await wallet.listCertificates({
  certifiers: [master.certifier],
  types: [certificateType]
})
console.log('    stored certificates:', certificates.length)
