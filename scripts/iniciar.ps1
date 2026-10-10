# ===================================================
#  SecureGuard - preparacion del entorno (Windows)
#  Lo llama INICIAR.bat. Busca un Python 3.10-3.12 (o lo
#  consigue con uv), crea .venv, instala requirements.txt
#  la primera vez y arranca scripts/iniciar.py.
# ===================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$Raiz = Split-Path -Parent $PSScriptRoot
Set-Location $Raiz
$Venv = Join-Path $Raiz ".venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"
$Requisitos = Join-Path $Raiz "backend\requirements.txt"
$Marca = Join-Path $Venv "secureguard-requisitos.txt"

function Escribir([string]$texto, [string]$color = "Gray") { Write-Host "  $texto" -ForegroundColor $color }

# $true si ese Python es 3.10, 3.11 o 3.12 (las versiones de requirements.txt)
function Es-Compatible([string]$exe, [string[]]$extra = @()) {
    try {
        $v = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        return ($LASTEXITCODE -eq 0) -and ("$v".Trim() -match '^3\.1[0-2]$')
    } catch { return $false }
}

function Buscar-Uv {
    $cmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $local = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    if (Test-Path $local) { return $local }
    return $null
}

$huella = (Get-FileHash $Requisitos -Algorithm SHA256).Hash
$listo = (Test-Path $VenvPy) -and (Test-Path $Marca) -and ("$(Get-Content $Marca -Raw)".Trim() -eq $huella) -and (Es-Compatible $VenvPy)
if ($listo) {
    & $VenvPy -c "import fastapi, aiohttp, uvicorn" 2>$null
    $listo = ($LASTEXITCODE -eq 0)
}

if (-not $listo) {
    Write-Host ""
    Escribir "Preparando SecureGuard (solo la primera vez, de 1 a 3 minutos)..." "Cyan"

    # Un .venv copiado de otra computadora o hecho con otro Python no sirve: se rehace
    if ((Test-Path $Venv) -and -not (Es-Compatible $VenvPy)) {
        Escribir "Rehaciendo el entorno de Python (.venv)..."
        try { Remove-Item -Recurse -Force $Venv -ErrorAction Stop }
        catch { Escribir "No pude borrar .venv. Cierra otras ventanas de SecureGuard y vuelve a intentar." "Red"; exit 1 }
    }

    $uv = Buscar-Uv
    if (-not (Test-Path $VenvPy)) {
        $base = $null
        foreach ($c in @(@("py", "-3.12"), @("py", "-3.11"), @("py", "-3.10"), @("python"), @("python3"))) {
            if (Get-Command $c[0] -ErrorAction SilentlyContinue) {
                $extra = @($c | Select-Object -Skip 1)
                if (Es-Compatible $c[0] $extra) { $base = $c; break }
            }
        }
        if ($base) {
            $exe = $base[0]; $extra = @($base | Select-Object -Skip 1)
            Escribir "Usando $(& $exe @extra --version)"
            & $exe @extra -m venv $Venv
        }
        if (-not (Test-Path $VenvPy)) {
            if (-not $uv) {
                Escribir "No encontré Python 3.10, 3.11 ni 3.12 en esta computadora." "Yellow"
                Escribir "Puedo instalar 'uv' (herramienta gratuita de Astral) para traer Python 3.12" "Yellow"
                Escribir "solo para este proyecto, sin tocar otros Python que tengas." "Yellow"
                $r = Read-Host "  ¿Continuar? [S/n]"
                if ($r -match '^[nN]') {
                    Escribir "Instala Python 3.12 desde https://www.python.org/downloads/ (marca 'Add python.exe to PATH') y vuelve a abrir INICIAR.bat."
                    exit 1
                }
                powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
                $uv = Buscar-Uv
                if (-not $uv) { Escribir "No se pudo instalar uv. Instala Python 3.12 desde https://www.python.org/downloads/" "Red"; exit 1 }
            }
            Escribir "Preparando Python 3.12 con uv..."
            & $uv venv --python 3.12 $Venv
            if (-not (Test-Path $VenvPy)) { Escribir "No se pudo crear el entorno de Python." "Red"; exit 1 }
        }
    }

    Escribir "Instalando dependencias (fastapi, uvicorn, aiohttp)..."
    if ($uv) {
        & $uv pip install --python $VenvPy -r $Requisitos
    } else {
        & $VenvPy -m pip --version 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { & $VenvPy -m ensurepip --upgrade 2>$null | Out-Null }
        & $VenvPy -m pip install --disable-pip-version-check -r $Requisitos
    }
    if ($LASTEXITCODE -ne 0) { Escribir "No se pudieron instalar las dependencias (¿hay conexión a internet?)." "Red"; exit 1 }
    Set-Content -Path $Marca -Value $huella -Encoding ASCII
    Write-Host ""
    Escribir "Si el firewall de Windows pregunta, permite el acceso en redes privadas" "Yellow"
    Escribir "(la placa NodeMCU / ESP32 se conecta a esta computadora por la red)." "Yellow"
}

& $VenvPy (Join-Path $Raiz "scripts\iniciar.py") @args
exit $LASTEXITCODE
