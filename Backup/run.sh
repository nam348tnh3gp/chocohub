apt update -y
apt install nodejs npm -y
npm cache clean --force
npm install better-sqlite3 dotenv
node backup.js
