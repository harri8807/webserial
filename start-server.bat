@echo off
echo 正在启动Web串口调试工具的HTTP服务器...
echo.
echo 服务器将在 http://localhost:8000 启动
echo 请在浏览器中访问该地址
echo.
echo 按Ctrl+C可以停止服务器
echo.
python -m http.server 8000
pause 