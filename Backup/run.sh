apt update -y
apt install nodejs npm git -y
git clone https://github.com/nam348tnh3gp/chocohub
cd chocohub
cd Backup
npm install better-sqlite3 dotenv
node backup.js
