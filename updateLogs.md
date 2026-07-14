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
