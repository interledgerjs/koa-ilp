# Koa ILP
> Koa middleware to charge for requests with ILP

Koa-ILP uses
[HTTP-ILP](https://github.com/interledger/rfcs/blob/master/0014-http-ilp/0014-http-ilp.md#http-ilp)
to charge for requests.

```js
// first, we start with an ordinary Koa app
const Koa = require('koa')
const router = require('koa-router')()
const app = new Koa()

// next, we import koa-ilp and automagically get a plugin using ilp-plugin. We
// construct our ilp middleware from the plugin.
const Ilp = require('koa-ilp')
const plugin = require('ilp-plugin')()
const ilp = new Ilp({ plugin })

// ENDPOINT 1: Hello

// Our first endpoint, '/hello', has a price of 1000 (in base units of our ledger.
// by default, ilp-plugin connects us to the XRP testnet so these are XRP drops).
// If we were connected to a dollar ledger with a scale of 9, these would be 1000
// nano-dollars.
const price = 1000

// We use ilp.options to create an options endpoint which returns payment instructions,
// enabling clients to fund a token on our server using interledger.
router.options('/hello', ilp.options({ price }))

// Next we use ilp.paid to create an actual paid endpoint. The route's code won't be
// run unless the client has paid 1000 XRP drops to us first.
router.post('/hello', ilp.paid({ price }), async ctx => {
  ctx.body = { message: 'Hello World!' }
})

// ENDPOINT 2: Random

// Our next endpoint, '/random', charges for random bytes. The price depends on how
// many bytes are requested, so the price is a function instead of an integer.
const PRICE_PER_RANDOM_BYTE = 20
const priceFunction = ctx => {
  return (+ctx.query.size || 16) * PRICE_PER_RANDOM_BYTE
}

// ilp.paid and ilp.options take a priceFunction in place of a static price. Otherwise
// this code works the same as the /hello endpoint.
router.options('/random', ilp.options({ price: priceFunction }))
router.get('/random', ilp.paid({ price: priceFunction }), async ctx => {
  ctx.body = crypto.randomBytes(ctx.query.size)
})

// ENDPOINT 3: File

// Our next endpoint, '/file/:file', charges a user to read a file off our machine.
// This depends on file size too, but reading a file is an async operation. We can
// define an async price function this time.
const fs = require('fs-extra')
const PRICE_PER_BYTE = 10
const asyncPriceFunction = async ctx => {
  const stats = await fs.stat(ctx.params.file)
  return stats.size * PRICE_PER_BYTE
}

// The async price function is passed in in place of the price. Otherwise this code
// functions the same as /hello and /random.
router.options('/file/:file', ilp.options({ price: asyncPriceFunction }))
router.get('/file/:file', ilp.paid({ price: asyncPriceFunction }), async ctx => {
  const file = await fs.readFile(ctx.params.file)
  ctx.body = file.toString('utf8')
})

app
  .use(parser)
  .use(router.routes())
  .use(router.allowedMethods())
  .listen(8080)
```
