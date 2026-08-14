@echo off
echo ========================================
echo Running Git Sync for samuelongitcode
echo ========================================

echo Setting local identity for samuelongitcode...
git config user.email "samuelongitcode@gmail.com"
git config user.name "samuelongitcode"

:: Ensure we are using the correct SSH key for this session
set GIT_SSH_COMMAND=ssh -i ~/.ssh/id_ed25519

echo Adding files...
git add .

echo Committing changes...
:: git commit -m "Automated sync commit"
git commit -m "vps-multiapp-cicd init"

:: Check if the remote is set to the correct SSH host
git remote set-url origin git@github.com:samuelongitcode/vps-multiapp-cicd.git

echo Pushing to main...
git push -u origin main

echo ========================================
echo Done!
echo ========================================
pause

:: del "C:\xampp\htdocs\samGit\2026may-samRunner\.git\index.lock"