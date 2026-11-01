@echo off
REM Inicia un servidor MongoDB local con los datos en backend-simple\data\db
cd /d "%~dp0"
if not exist "data\db" mkdir "data\db"
"C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe" --dbpath "%~dp0data\db" --bind_ip 127.0.0.1 --port 27017
