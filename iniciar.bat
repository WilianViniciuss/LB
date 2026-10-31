@echo off
cd /d "%~dp0"
title Lancamento de Boletos - servidor (nao feche esta janela)
node src\servidor.js
pause
