@echo off
rem Duplo clique para rodar o Boss Raid na maquina. Faz tudo pelo rodar-local.ps1
rem (ExecutionPolicy Bypass so para este script: o Windows bloqueia .ps1 baixado por padrao).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rodar-local.ps1"
pause
