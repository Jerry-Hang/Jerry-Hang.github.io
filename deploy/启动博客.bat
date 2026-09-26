@echo off
REM ===== 博客服务器启动器（Windows）=====
REM 双击即可启动，服务在后台运行，关闭本窗口不影响。
REM 完整说明见同目录的「Windows部署说明.md」

cd /d "%~dp0"

echo ============================================
echo   JerryHang 博客服务器
echo ============================================
echo.

REM 检查可执行文件
if not exist "..\target\release\blog_server.exe" (
    echo [错误] 找不到 blog_server.exe
    echo        请先在 D:\3D_Work\Blog 执行: cargo build --release
    echo.
    pause
    exit /b 1
)

REM 检查运行数据
if not exist "..\blog.db" (
    echo [警告] 找不到 blog.db —— 文章数据为空
    echo        请从手机 Termux 拷贝: ~/DSH_work/blog_server_rust/blog.db
    echo.
)
if not exist "..\config.toml" (
    echo [警告] 找不到 config.toml —— 将使用默认密码
    echo        默认账号: admin
    echo        默认密码: change-me-on-first-login
    echo        请尽快用 --hash 生成新密码并写入 config.toml
    echo.
)

REM 检查是否已在运行
tasklist /FI "IMAGENAME eq blog_server.exe" 2>nul | find /I "blog_server.exe" >nul
if %ERRORLEVEL%==0 (
    echo [提示] 服务似乎已在运行。
    echo        如需重启，请先执行:
    echo        taskkill /F /IM blog_server.exe
    echo.
    pause
    exit /b 0
)

echo 正在启动服务...
REM -NoWait：启动后立即返回，服务在后台常驻。
REM （不加 -NoWait 的话本窗口会一直挂着等待服务退出）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动博客.ps1" -NoWait

echo.
echo ============================================
echo   服务已在后台运行
echo ============================================
echo.
echo   博客前台:  http://127.0.0.1:8090
echo   管理后台:  http://127.0.0.1:8091
echo.
echo   停止服务:  taskkill /F /IM blog_server.exe
echo   查看日志:  ..\logs\
echo.
echo   本窗口可以关闭。
echo.
pause
