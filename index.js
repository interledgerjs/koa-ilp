'use strict'

const debug = require('debug')('koa-ilp')
const crypto = require('crypto')
const PSK2 = require('ilp-protocol-psk2')
const BigNumber = require('bignumber.js')
const bodyParser = require('koa-bodyparser')

const PAYMENT_METHOD_IDENTIFIER = 'interledger-psk2'

const base64url = buffer => buffer.toString('base64')
  .replace(/=/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')

module.exports = class KoaIlp {
  constructor ({ plugin }) {
    this.plugin = plugin
    this.balances = {}
    this.bodyParser = bodyParser()
  }

  async connect () {
    if (this.psk2) return
    this.psk2 = await PSK2.createReceiver({
      plugin: this.plugin,
      paymentHandler: async (params) => {
        const token = base64url(params.id)

        // TODO: begin fulfill and put balance into a pending state that causes
        // requests on the token to wait until the fulfill is complete.
        if (this.balances[token]) {
          this.balances[token] = this.balances[token].add(params.prepare.amount)
        } else {
          this.balances[token] = new BigNumber(params.prepare.amount)
        }

        debug(`received payment for token ${token} for ${params.prepare.amount}, new balance ${this.balances[token].toString()}`)

        try {
          return params.acceptSingleChunk()
        } catch (err) {
          console.error('error fulfilling incoming payment', params, err)
        }
      }
    })
  }

  getPayHeader (price) {
    const psk = this.psk2.generateAddressAndSecret()

    // price comes last because it's an optional argument
    return PAYMENT_METHOD_IDENTIFIER + ' ' +
      psk.destinationAccount + ' ' +
      psk.sharedSecret.toString('base64') +
      (price ? (' ' + price) : '')
  }

  options ({ price }) {
    return async (ctx, next) => {
      await this.connect()

      const _price = await Promise.resolve((typeof price === 'function')
        ? price(ctx)
        : price)

      ctx.set('Pay', this.getPayHeader(_price))

      const paymentToken = ctx.get('Pay-Token')
      if (paymentToken) {
        ctx.set('Pay-Balance', (this.ilp.balances[paymentToken] ||
          new BigNumber(0)).toNumber())
      }

      ctx.status = 204
      await next()
    }
  }

  paid ({ price, optional = false }) {
    return async (ctx, next) => {
      if (!this.plugin.isConnected()) {
        await this.plugin.connect()
      }

      await this.connect()

      const _price = (typeof price === 'function')
        ? price(ctx)
        : price

      if (new BigNumber(_price).eq(0)) {
        await next()
        return
      }

      const paymentToken = ctx.get('Pay-Token')
      if (!paymentToken) {
        ctx.throw(402, 'No valid payment token provided')
      }


      // TODO make sure an attacker can't overwhelm us with tokens
      let balance
      if (this.balances[paymentToken]) {
        balance = this.balances[paymentToken]
      } else {
        balance = new BigNumber(0)
      }

      const headers = {
        'Pay': this.getPayHeader(_price),
        'Pay-Balance': balance.toNumber()
      }

      if (!optional && (new BigNumber(0)).greaterThanOrEqualTo(balance)) {
        ctx.throw(402, `Your Payment Token ${paymentToken} has no funds available. It needs at least ${_price}`, { headers })
      }

      let paid
      if (balance.lessThan(_price)) {
        if (!optional) {
          ctx.throw(402, `Your Payment Token ${paymentToken} does not have sufficient funds available (has: ${balance}. It needs at least: ${_price})`, { headers })
        }

        paid = false
      } else {
        // Update the token balance
        balance = balance.minus(_price)

        paid = true
      }

      ctx.set('Pay', headers.Pay)
      ctx.set('Pay-Balance', balance.toNumber())

      // Pass payment details to subsequent middleware
      ctx.state.payment = {
        token: paymentToken,
        balance,
        paid,
        price: _price
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
