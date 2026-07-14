# The CCPOW White Paper

## What is CCPOW?
CCpow is a PoW (Proof-of-work) Based coin with PoS (Proof of Stake) Rewards for people that stake our coin

---

## How does mining work, and which devices it supports?
CCpow uses SHA256 (Pure Sha256) proofs as mining algo, which can be mined by almost any device, from microcontrollers to GPUS

CCpow can be mined by:
* Phones
* Cpus
* Gpus
* Arduinos
* ESPs
* Other devices that supports sha256

(We accept PRs for mining support to other devices!)

---

## Is Mining fair? Is it profitable?
This is a good question, we use device based multipliers to miners

| Device Type | Multiplier |
| :--- | :--- |
| `embedded_avr` | 3.5 |
| `embedded_arm` | 3.0x |
| `embedded_esp` | 2.5x |
| `embedded_esp32` | 2.0x |
| `mobile` | 1.8x |
| `cpu` | 1.0x |
| `gpu` | 1.0x |
| `ASIC` (upcoming) | 0.5x |

> In case of microcontrollers mining, mostly devices are more profitable than electricity bills (depends highly on device, compared to other coins, ours is more profitable ON MICROCONTROLLERS)

---

## Is your project open source?
Yes, its fully open source, and can be viewed by anyone at any time on our official repo.

---

## My Device isnt supported, what can i do?
You can go to our discord server (https://discord.gg/uDJsuN28FK) and check if theres any beta release for your device or fork our repo and make it your own, we are fully open to PRs!

---

## I have an idea, where can i contact you?
You can go to our discord server, at #「💡」・say-your-ideas, we are really open to the community opinion!

---

## Is there any swap minimum or limit?
Not actually, you can ask a withdraw any time and will be handled by our automatic payment server.
No minimums, No limits.

---

## Is there any anti cheat?

Yes, we have a strict anti-cheat that uses diff and solve time to validate, the anti-cheat is tolerant to lucky, but not to obvious hacking, you have 3 warnings, when you get the final flag, you cant mine anymore until an admin check your account

## Is alt account legal?

Kinda. We dont recommend (as it doesnt helps your profit), but if you want, we dont have problems with it.

## Is the project fully public?

Yes, it is.
Only the payments server doesnt, as hackers would target our project if they know how it works, so we run it on a private repo with firewall.

## How is the swap pool funded?

The liquidity pool is funded by investors (new users that want to try the project by buying some CC),
The stratum mining (Mine xmr, btc or other coins, receive on CC, with only 2% fee for funding microcontroller pool)
The AI inference nodes (People that run or buy AI usage with CC, giving the coin utility)
the Donators (Anyone that believes in our project and donates some crypto for funding)
The People who sell CC (The CC is moved to the swap_liquidity user, you can manually send CC to this account for funding!)

---

## How is the account security made?

For now, we only use username + PIN, and only admins can actually access it.
Every single backup node uses `Diffie–Hellman` for safing our network, no one can access data without dealing with it.
We plan to on future use a more strong way to make username + PIN safer

---
## What are you planning?
CCpow and the entire chocohub ecosystem will be completely different on next versions:
* Real liquidity
* Other algo mining (mine xmr, btc or other coins, receive on CC)
* AI nodes (what is it? its a feature where anyone can run a AI node and receive for its usage)
* Semi decentralize of ccpow (distribute between trusted nodes and non-trusted nodes)

---

## Why mine CCPOW?
1. More Profitable than other microcontroller based coins
2. You can stake it at any time, easy manage with web wallet, and mine on almost any device
3. Low Gas fees (only 1% for sending to other user, and mostly sendings are really low, like cents)
4. If you dont like mining you can run an AI node or a mining node and receive for its usage
5. Swaps at any time

---

## If i make an investment now, will i lost it on 1.0.6?
Its highly recommended to swap you coins before 1.0.6, because we may need to restart data, we will make sure to announce it!

Any investment done at this moment wont be lost, it will be converted to other coins like xno, and if you believe on CC you can buy it again, but this time with real liquidity!

Chocohub is only on its start, we plan big things to come up on future!

> Warning: CCpow is on a faucet state at this moment, You are being paid for testing and having fun, profits will be higher when real liquidity comes out! (patch 1.0.6)
>
> *you can swap these faucet coins at any time for free and with no minimum amounts.*
> *swapping your coins before 1.0.6 is highly recommended for a fresh start.*
