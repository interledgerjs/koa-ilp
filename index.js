'use strict'

const debug = require('debug')('koa-ilp')
const crypto = require('crypto')
const ILP = require('ilp')
const BigNumber = require('bignumber.js')
const bodyParser = require('koa-bodyparser')

const base64url = buffer => buffer.toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

module.exports = class KoaIlp {
  constructor ({ plugin }) {
    this.plugin = plugin
    this.secret = crypto.randomBytes(32)
    this.balances = {}
    this.rpcUrl = '/__ilp_rpc'
    this.bodyParser = bodyParser()

    this.plugin.on('error', (err) => {
      console.error('plugin error:', err)
    })

    ILP.PSK.listen(this.plugin, {
      receiverSecret: this.secret
    }, async (incomingPayment) => {
      if (incomingPayment.data.length !== 16) {
        throw new Error('Invalid token length')
      }
      const token = base64url(incomingPayment.data)

      try {
        await incomingPayment.fulfill()
      } catch (err) {
        console.error('error fulfilling incoming payment', incomingPayment, err)
      }

      if (this.balances[token]) {
        this.balances[token] = this.balances[token].add(incomingPayment.transfer.amount)
      } else {
        this.balances[token] = new BigNumber(incomingPayment.transfer.amount)
      }

      debug(`received payment for token ${token} for ${incomingPayment.transfer.amount}, new balance ${this.balances[token].toString()}`)
    })
  }

  rpc ({ token }) {
    return async (ctx, next) => {
      if (!this.plugin.isConnected()) {
        await this.plugin.connect()
      }

      if (ctx.request.url.substring(0, this.rpcUrl.length) !== this.rpcUrl) {
        await next()
        return
      }

      await this.bodyParser(ctx, () => null)
      const prefix = ctx.query.prefix
      const method = ctx.query.method
      const auth = ctx.request.headers.authorization

      if (typeof prefix !== 'string' || typeof auth !== 'string') {
        console.error('unauthorized rpc request', ctx.query, ctx.request.body)
        return ctx.throw(401)
      }
      if (!method) {
        return ctx.throw(400, 'method is required')
      }

      const [ , authToken ] = auth.match(/^Bearer (.+)$/) || []
      if (authToken !== token) {
        console.error('unauthorized rpc request', ctx.query, ctx.request.body)
        return ctx.throw(401)
      }

      try {
        ctx.body = await this.plugin.receive(method, ctx.request.body)
        ctx.status = 200
      } catch (err) {
        console.error('error processing rpc request', err)
        return ctx.throw(422, err.message)
      }
    }
  }

  paid ({ price, optional = false }) {
    return async (ctx, next) => {
      if (!this.plugin.isConnected()) {
        await this.plugin.connect()
      }

      const paymentToken = ctx.get('Pay-Token')

      if (!paymentToken) {
        ctx.throw(402, 'No valid payment token provided')
      }

      const ilpAddress = this.plugin.getAccount()
      const psk = ILP.PSK.generateParams({
        destinationAccount: ilpAddress,
        receiverSecret: this.secret
      })

      // TODO make sure an attacker can't overwhelm us with tokens
      let balance
      if (this.balances[paymentToken]) {
        balance = this.balances[paymentToken]
      } else {
        balance = new BigNumber(0)
      }

      const headers = {
        'Pay': String(price) + ' ' + psk.destinationAccount + ' ' + psk.sharedSecret,
        'Pay-Balance': balance.toNumber()
      }

      if (!optional && (new BigNumber(0)).greaterThanOrEqualTo(balance)) {
        ctx.throw(402, `Your Payment Token ${paymentToken} has no funds available. It needs at least ${price}`, { headers })
      }

      let paid
      if (balance.lessThan(price)) {
        if (!optional) {
          ctx.throw(402, `Your Payment Token ${paymentToken} does not have sufficient funds available (has: ${balance}. It needs at least: ${price})`, { headers })
        }

        paid = false
      } else {
        // Update the token balance
        balance = balance.minus(price)

        paid = true
      }

      ctx.set('Pay', headers.Pay)
      ctx.set('Pay-Balance', balance.toNumber())

      // Pass payment details to subsequent middleware
      ctx.state.payment = {
        token: paymentToken,
        balance,
        paid,
        price
      }

      // Save balance
      if (balance.greaterThan(0)) {
        this.balances[paymentToken] = balance
      } else {
        delete this.balances[paymentToken]
      }

      await next()
    }
  }
}
