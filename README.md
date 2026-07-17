# Internalizing unconfirmed outputs into a BRC-100 wallet

A wallet can take custody of an output the instant a miner accepts it. It does not need to wait for a
block, a confirmation, or a merkle proof — none of which exist yet.

These three examples show that, each in one file, with no framework. Each one broadcasts, then
internalizes the still-unmined transaction, and prints the resulting `unproven` status: held, spendable,
and provably not confirmed.

| File | Protocol | Shows |
|---|---|---|
| `1-payment.ts` | `wallet payment` | A BRC-29 payment landing in spendable balance |
| `2-token-basket.ts` | `basket insertion` | A real 1Sat Ordinal (SVG inscription) landing in a basket |
| `3-certificate.ts` | both | A signed credential as a real 1Sat Ordinal, vs. a BRC-52 identity certificate |

Nothing here is mocked: real inscriptions, real transactions, broadcast to whatever chain your wallet
is on.

## Why this works

`internalizeAction` takes **Atomic BEEF** (BRC-95). BEEF carries a transaction together with its
ancestry and the merkle proofs of its **mined ancestors** — and nothing else.

There is no proof for the transaction being handed over. There cannot be: it was made a moment ago.
The recipient does not need one. It walks the ancestry back to transactions that *are* proven,
verifies those proofs against block headers it already trusts, and checks that the new transaction
spends them validly. That is a complete SPV proof of validity, and none of it depends on the new
transaction having been mined.

So the receiver can answer "is this transaction valid?" on its own, immediately, with no block and no
proof. That is what makes internalizing an unconfirmed output reasonable.

## Broadcast first, then internalize

**SPV validity is not double-spend safety, and that distinction decides the ordering.**

BEEF proves a transaction is well-formed and that its inputs existed. It cannot prove those inputs are
still unspent, because that fact isn't in the transaction — it lives in the miners' mempools. A wallet
will cheerfully internalize a transaction nobody has broadcast, and it will look exactly like a
received payment. But until a miner accepts it, the sender can spend the same inputs elsewhere, and
first-seen — the thing that actually secures a 0-conf payment — hasn't started. If nobody ever
broadcasts it, it simply dies. Either way the output reads as held right up until it silently
evaporates.

So every example here broadcasts first and internalizes second. You lose nothing by doing this: an
accepted transaction is still unmined, still has no merkle proof, and still internalizes as
`unproven`. The demonstration is unaffected; only the risk goes away.

The two questions are worth keeping apart:

| Question | Answered by |
|---|---|
| Is this transaction valid? | BEEF, locally, instantly |
| Can these inputs still be spent out from under me? | a miner accepting it — nothing else |

Confirmation answers a third question — "will this stay true?" — and arrives later, on its own schedule.

## The lifecycle you'll see

```
   broadcast              → a miner accepts it; inputs are locked to this tx
   internalizeAction      → custody. status: unproven   ← no merkle proof exists yet
   (a block is mined)
   Monitor attaches proof → status: completed
```

`unproven` is not a defect. It is the honest name for "valid, accepted, held, and not yet mined."
Re-run `listActions` a few minutes after a script and you'll watch it flip to `completed` on its own.

(`nosend` is a fourth status, for a tx deliberately never shared with the network. These examples
don't use it — an unbroadcast tx never confirms, so its outputs are permanent dead-ends. It has real
uses, but "someone paid me" is not one of them.)

## The two protocols

**`wallet payment`** — "these coins are mine, put them in my balance." The wallet must derive the
key to know it can spend them, so you must supply a `paymentRemittance`:

```ts
paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
```

All three are required. `senderIdentityKey` especially — the receiver derives its private key as
`rootKey.deriveChild(senderIdentityKey, invoiceNumber)`, mirroring what the sender did with
`counterparty.deriveChild(senderPriv, invoiceNumber)`. Same ECDH secret from opposite sides. Without
the sender's identity key there is no secret and no key.

**`basket insertion`** — "hold this UTXO under this name." No derivation, no remittance, no key:

```ts
insertionRemittance: { basket: 'demo-buzzmint-ordinals', tags: [...], customInstructions: '...' }
```

The wallet does not parse the locking script. It has no idea what an ordinal is. It stores the coin
and hands back the `tags` and `customInstructions` you supplied. Any meaning the output has is yours
to attach and yours to enforce.

This is why `customInstructions` matters more than it looks. The examples inscribe to a
**wallet-derived** key and record the recipe:

```ts
customInstructions: JSON.stringify({ protocolID, keyID, counterparty: 'self', ... })
```

That is how you re-derive the key to spend the ordinal later. Custody of a coin you can't unlock is
worth nothing, and the wallet will not remember for you.

## Baskets are a shared namespace

There is no per-app isolation. A basket is just a string, and every app talking to the wallet sees
the same flat namespace. Insert into `stas-tokens` and your test data lands in with real holdings —
`listOutputs` will hand you both, and nothing marks which is which except tags you chose yourself.

This is not hypothetical; it happened while writing these examples. Everything here writes to
`demo-buzzmint-`prefixed baskets, filters by tag, and matches on outpoint rather than trusting
`outputs[0]`.

Use `relinquishOutput({ basket, output })` to remove something from a basket. It gives up the
wallet's custody of that output; it does not spend or destroy it.

## Where these show up in a wallet

In its baskets — that's the whole story. A basket is a storage location, not a display contract.

If your wallet has a curated token or assets view, don't expect these there: such views are built
around fungible token standards, and a 1Sat Ordinal isn't one. Nothing is wrong when an ordinal
doesn't appear in an asset list. Look for it in the basket you put it in, and in any ordinals
explorer — the scripts print a link.

## Running them

Requires BSV Desktop running and unlocked (the examples connect via `'auto'`, which finds it on
`localhost:2121` or `:3321`).

```sh
npm install
npm run payment
npm run token
npm run certificate
```

Each script generates a throwaway sender key and has your wallet fund it, so there is nothing to set
up.

**These scripts spend money.** They read the chain from the wallet (`getNetwork`) and follow it, so on
a mainnet wallet every run broadcasts two real transactions and spends real satoshis — a few thousand
per run, with the remainder returning to you as change. Point Desktop at testnet if you just want to
watch the mechanics.

The wallet will prompt for permission on `internalizeAction` — that is `seekPermission`, which
defaults to true.

## Traps worth knowing

Each of these cost real time while writing these examples.

**`randomizeOutputs` defaults to `true`.** `createAction` shuffles your outputs to make change harder
to identify. If you assume `outputIndex: 0` without turning it off, your code works until it doesn't:

```ts
options: { randomizeOutputs: false }
```

**`acceptDelayedBroadcast` also defaults to `true`.** `createAction` returns as soon as the wallet has
*queued* the broadcast, not when the network has accepted it. If you immediately spend that output,
your child transaction can reach a miner before its parent does and is rejected:

```
broadcast rejected: unexpected response code 500: Missing inputs
```

It is a race, so it fails intermittently — the worst kind. If something downstream depends on the tx
actually being out there, say so:

```ts
options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
```

**Check the broadcast result.** `tx.broadcast()` resolves rather than throwing on rejection. Ignore it
and you'll believe you published something you didn't:

```ts
const bc = await tx.broadcast(broadcaster)
if (bc.status === 'error') throw new Error(bc.description)
```

**`listActions` filters by label and nothing else.** There is no txid filter and no documented
ordering, so `listActions({ labels: ['my-demo'], limit: 1 })` does *not* mean "the action I just
made" — it means "some action carrying that label", and once you've run twice, that's very likely an
older one. It reads correctly on the first run and quietly lies afterwards. Label each run uniquely:

```ts
const runLabel = `demo-${txid.slice(0, 16)}`
await wallet.internalizeAction({ ..., labels: ['buzzmint-demo', runLabel] })
const { actions } = await wallet.listActions({ labels: [runLabel], limit: 1 })
```

**Don't trust a block explorer's script rendering.** WhatsOnChain's API omits the leading `OP_0` of an
inscription envelope in both its `asm` and `hex` fields, which makes a perfectly valid 1Sat Ordinal
look malformed. Parse the raw bytes instead:

```ts
const tx = Transaction.fromHex(rawHex)
tx.outputs[0].lockingScript.chunks[0]   // { op: 0 }  — OP_FALSE
tx.outputs[0].lockingScript.chunks[1]   // { op: 99 } — OP_IF
```
