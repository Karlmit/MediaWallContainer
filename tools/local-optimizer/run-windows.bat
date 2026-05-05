@echo off
setlocal
cd /d "%~dp0\..\.."
node tools\local-optimizer\optimizer.js
