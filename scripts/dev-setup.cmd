@echo off
setlocal

powershell -ExecutionPolicy Bypass -File "%~dp0dev-setup.ps1" %*
exit /b %errorlevel%
