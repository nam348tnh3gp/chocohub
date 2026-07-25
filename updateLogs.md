BloodFell [BITE],  — 7/8/2026 8:47 PM
Main Server Patch
patch 1.0.4.2

CC to XNO swaps are now supported and totally automatically!

(xno to cc is under development, not recommended to use)

@💎 Economy-Ping
BloodFell [BITE],  — 7/9/2026 4:45 PM
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

Found a bug? say in:  ⁠unknown 

@💢 PoW-Ping
BloodFell [BITE],  — 7/9/2026 10:29 PM
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
BloodFell [BITE],  — 7/10/2026 5:32 PM
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
BloodFell [BITE],  — 7/12/2026 12:20 PM
Bot Update
patch 1.0 (Never logged)

Fixed infinite daily caused by server not sending success on transfers

Added support to ! on mostly commands

Other minor bug fixes

Added !Miner-info Command
BloodFell [BITE],  — 7/13/2026 6:46 PM
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
BloodFell [BITE],  — 7/13/2026 10:04 PM
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
BloodFell [BITE],  — 7/14/2026 8:44 PM
Main Server Patch
L anti cheat fix
patch 1.0.4.7

>> Fixes:

Fixed L anti cheat causing fair miners to receive warnings

the mobile tier tolerance was changed 500Kh/s -> 40Kh/s

Fixed miner tiers randomly changing from device_type to cpu randomly (was affecting profits)

Fixed server accepting same nonce twice

All warnings caused got removed

Have Fun!

@💢 PoW-Ping 
BloodFell [BITE],  — 7/15/2026 5:16 PM
Main Server Patch
Sins of the past
patch 1.0.4.7.5

>> Fixes:

Fixed old support to backup token, which anyone that founds it would pull a malicious backup, now only TRUSTED urls with Diffie hellman can pull/push backups

Fixed anti cheat one more time, 

Changed mobile tolerance from 40khs to 200khs, this doesnt mean you with a pc can simply mine as mobile if your hashrate is below this, you may still get flags for wrong tier

Changed gpu tier multiplier from 1.0x to 2.0x

other fixes

Have Fun!

@💢 PoW-Ping
BloodFell [BITE],  — 7/16/2026 2:44 PM
Main Server Patch
Just a Splash of Paint
patch 1.0.4.8 

>> Fixes:

fully refactored admin dashboard

added mining nodes management to admin dashboard 

added icons to users on admin dashboard

added ''details'' about user in admin dashboard (last transactions, swaps and others)

added "remove" option in admin dashboard (we dont need to delete your user anymore XD)

i dont think ''have fun'' makes sense with this patch
 [BITE], 
BloodFell [BITE],  — 7/16/2026 2:51 PM
mining nodes fix + full working (some features dont work rn) next patch
BloodFell [BITE],  — 7/20/2026 7:03 PM
Bot Patch
patch 1.0.1
fixes and more cool things
>> Fixes:

Fixed Giveaway Error, changed to Pending

Added a backup system, now you dont need to link everytime

Added a level system, each message gives 2.5xp, 100xp per level
every time you level up you gain some CC to your linked account

Added level leaderboard, use /leaderboard type level or /rank to see your own level

Please use /link-account again (old data was lost)
@everyone 

Have Fun! 
just to remember, you need to have your account linked for receiving rewards (giveaways, level rewards and others)
BloodFell [BITE],  — 7/21/2026 2:37 PM
Main server Patch
A micro fix for a micro project
patch 1.0.4.8.5

>> Fixes:

Fixed starting diff at 10 causing problems to avr (now starts with tier appropriated diff)

Avr starting diff changed from 2 to 1 (before it was getting override by a diff 10)

Fixed endpoints still working for banned users (now returns account banned

Fixed Snake faucet showing 24h cooldown instead of 15m

Fixed XNO to CC requiring MEMO (which doesnt exists on xno network

Have Fun!

Warning, this patch is subdivided in 2 parts, the next one will be the one that includes mining nodes fix

@💢 PoW-Ping
we are close to 1.0.5
BloodFell [BITE],  — 7/23/2026 2:27 PM
Main Server Patch
It’s not upstream, It’s you.
patch 1.0.5

State: Testing, fixing

>> added:

Mining nodes generating jobs locally, causing the main server dont need to deal with it

Added block sync on mining nodes (NEED DH AND TRUSTED-NODE TOKEN)

Added better error logs, instead of upstream error you may see job not found for example 

Nodes with changes:

*Chocohub Asia Node (Singapore)*

THIS IS THE ONLY NODE YOU WILL SEE DIFFERENCES

Fixes:

Removed a lot of vietnamese/useless comments on server, preserving only the useful ones

Removed THE ENORMOUS HTML ON SERVER (admin log in and dashboard), moved to Views/admin

This update is being tested, you can actually mine to the updated node, but you will see 0 as reward (you actually get the reward but the mining node dont know your reward), Use with caution

Have Fun!

@💢 PoW-Ping 
remember, the mining nodes will be updated/fixed up to 1.0.6 with the other fixes included on roadmap, STAY TUNED!
BloodFell [BITE],  — 7/23/2026 4:02 PM
Main Server Patch
As you wish, siurek (LOL)
patch 1.0.5.1

>> Added:

support to device type on Submit solution, now you dont need to use mining/tier endpoint to register tier, just parsing device type on solution!

Mining/tier endpoint support is preserved, but deprecated, you can still use it normally

Have Fun!

@💢 PoW-Ping
BloodFell [BITE],  — 7/23/2026 6:34 PM
Main Server & Bot Patch
I Can See Clearly Now
patch 1.0.5.1.2

>> Fixes:

Fixed bot showing diff as undefined, now showing real diff

Fixed server not parsing miner info on miner info endpoint (device type and diff), now parsing correctly and storing

Fixed the last 10m reward showing as 0 even while the miner list 10m reward correctly, now just use miner1 + miner2 + other miners 10m reward = total 10m reward

>> Added:

device_type on bot !miner-info command.

Have Fun!

@💢 PoW-Ping 
