The CCPOW White Paper
---------------------------------------------

What is CCPOW?
CCpow is a PoW (Proof-of-work) Based coin with PoS (Proof of Stake) Rewards for people that stake our coin

How does mining work, and which devices it supports?
CCpow uses SHA256 proofs as mining algo, which can be mined by almost any device, from microcontrollers to GPUS

CCpow can be mined by Phones, Cpus, Gpus, Arduinos, ESPs and other devices that supports sha256 (We accept PRs for mining support to other devices!)

Is Mining fair? Is it profitable?
This is a good question, we use device based multipliers to miners

embedded_avr Multiplier: 3.5
embedded_arm Multiplier: 3.0x
embedded_esp Multiplier: 2.5x
embedded_esp32 Multiplier: 2.0x
mobile Multiplier: 1.8x
cpu Multiplier: 1.0x
gpu Multiplier: 1.0x
(upcoming ASIC, 0.5x)

In case of microcontrollers mining, mostly devices are more profitable than electricity bills (depends highly on device, compared to other coins, ours is more profitable ON MICROCONTROLLERS)

Is your project open source?
Yes, its fully open source, and can be viewed by anyone at any time on our official repo.

My Device isnt supported, what can i do?

you can go to our discord server (https://discord.gg/uDJsuN28FK) and check if theres any beta release for your device or fork our repo and make it your own, we are fully open to PRs!

I have an idea, where can i contact you?

you can go to our discord server, at #「💡」・say-your-ideas, we are really open to the community opinion!

Is there any swap minimum or limit?

Not actually, you can ask a withdraw any time and will be handled by our automatic payment server.
No minimums, *No limits*.

What are you planning?
CCpow and the entire chocohub ecosystem will be completely different on next versions, real liquidity, other algo mining (mine xmr, btc or other coins, receive on CC), AI nodes (what is it? its a feature where anyone can run a AI node and receive for its usage), and semi decentralize of ccpow (distribute between trusted nodes and non-trusted nodes)

Why mine CCPOW?
1. More Profitable than other microcontroller based coins

2. you can stake it at any time, easy manage with web wallet, and mine on almost any device

3. Low Gas fees (only 1% for sending to other user, and mostly sendings are really low, like cents)

4. if you dont like mining you can run an AI node or a mining node and receive for its usage

5. Swaps at any time

if i make an investment now, will i lost it on 1.0.6?

Its highly recommended to swap you coins before 1.0.6, because we may need to restart data, we will make sure to announce it!

any investment done at this moment wont be lost, it will be converted to other coins like xno, and if you believe on CC you can buy it again, but this time with real liquidity!

Chocohub is only on its start, we plan big things to come up on future! 
Warning CCpow is on a faucet state at this moment, You are being paid for testing and having fun, profits will be higher when real liquidity comes out! (patch 1.0.6)
> *you can swap these faucet coins at any time for free and with no minimum amounts.*
> *swapping your coins before 1.0.6 is highly recommended for a fresh start. *

Last Updates log:

Main Server Patch
patch 1.0.4.2

CC to XNO swaps are now supported and totally automatically!

(xno to cc is under development, not recommended to use)

@💎 Economy-Ping

Main Server Patch
patch 1.0.4.3

The balancing update
Problem: miners getting insane diff due to no diff cap, and first blocks getting instantly solved (diff too low)

>> Fix: added Starting Diff cap

Device:
embedded_avr    Starting diff: 2
embedded_arm Starting diff: 5
embedded_esp Starting diff: 50
embedded_esp32 Starting diff: 100
mobile Starting diff: 100
cpu Starting diff: 200 (why so low? because its the default for no device type miners)
gpu Starting diff: 500 (why so low? diff gets adjusted REALLY QUICK, and low performance Gpus/old gpus can mine too, like a gt210)

Found a bug? say in:  ⁠「🛠」・support 

@💢 PoW-Ping

Main Server Patch
Quick Fix, New feature
patch 1.0.4.4

>> Fixes:

Removed hardcoded Urls from mining.html

Fully implemented Manual selection of mining nodes while mining

Fixed Bot showing no data about mining nodes}

Fixed selected mining node getting override by auto

Added a new node in india, by sree.P

Added 2 new backup nodes for preserving data

Have Fun!

@💢 PoW-Ping 

Main Server Patch
Fixes, Preparing...
patch 1.0.4.5

>> Fixes:

Added auto re register on mining nodes, this ensures that after a minor bug and restart, they can still work

got the cpu diff cap lower, now up to 10000

Fixed Server Choosing a non data node on restart, making it restart with no data

Added Miner info endpoint on server (not UI for now)

Added hourly giveaways on bot, it auto sends prize to your account once its linked

Server is now more Strict about Tiers, which can cause flags to your account for suspicious activity, avoid changing tier!

Fixed mining nodes not receiving the 5%

added !daily again (accidentally removed last patch)

Mining Html fix by Sree P.

other minor fixes

@💢 PoW-Ping 

Main Server Patch
Fixes, getting better, getting safer.
patch 1.0.4.6

>> Fixes:

Fixed server punishment only for worker (now your user is punished, using other worker wont help)

Fixed Server minting coins on swap (now removed from pool, swap_liquidity user)

Fixed Exposed content on .env (credentials changed now, and not public anymore)

Fixed miners not receiving fees from TX

Fixed XNO payment server accepting username as adress, causing rate limiting on RPC

Renamed send.py to DucoWithdraw.py

Fixed Server sending old worker (not active anymore

Added more parameters on miner info (not added to bot for now)

other minor fixes

even more strict anti cheat, based on diff and solve time

@💢 PoW-Ping 

Main Server Patch
The Payment update
patch 1.0.4.6.1

>> Fixes:

Changed the local slow PoW from xno to a chain of public nodes, this will cause xno withdraws to be way more quick

Fixed XNO to CC swaps (YOU DONT NEED TO INCLUDE MEMO, BUT AMOUNT NEEDS TO BE EXACTLY)

Changed receive wallet from duco and xno to ecosystem balances, every coin spend is used to next swaps

Duco and XNO payments are now running on same server, and both 24/7

Have Fun!

@💢 PoW-Ping @💎 Economy-Ping 
