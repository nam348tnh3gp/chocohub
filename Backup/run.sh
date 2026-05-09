apt update -y
apt install nodejs npm -y
git clone https://github.com/nam348tnh3gp/chocohub
cd chocohub/Backup
npm cache clean --force
npm install better-sqlite3 dotenv
node backup.js
