# Boss Raid - rodar na maquina (Windows)
#
# Faz tudo que falta pra subir o app local:
#   1. confere Node >= 18
#   2. instala as dependencias (npm install)
#   3. cria o .env e pede o Client ID / Client Secret do app "Boss Raid live"
#   4. confere se a porta 3000 esta livre (o SubPack usa a mesma porta)
#   5. sobe o servidor e abre o navegador em /entrar
#
# Rodar de novo e seguro: so pede o que ainda estiver faltando.
# Para parar o servidor: Ctrl+C nesta janela (nunca feche a janela no X com o
# servidor rodando - o banco local nao se recupera de desligamento a forca).
#
# Texto sem acento de proposito: o PowerShell do Windows le .ps1 sem BOM como ANSI.

$ErrorActionPreference = "Stop"
$raiz = $PSScriptRoot
Set-Location $raiz

function Passo($texto) { Write-Host "`n==> $texto" -ForegroundColor Magenta }
function Falha($texto) { Write-Host "`n[x] $texto" -ForegroundColor Red; exit 1 }

# ---------- 1. Node ----------
Passo "Conferindo o Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Falha "Node.js nao encontrado. Instale a versao LTS (winget install OpenJS.NodeJS.LTS) e rode este script de novo."
}
$versao = (& node -v).TrimStart("v")
if ([int]($versao.Split(".")[0]) -lt 18) {
  Falha "Node $versao e antigo demais - precisa ser 18 ou mais novo (winget upgrade OpenJS.NodeJS.LTS)."
}
Write-Host "Node $versao ok"

# ---------- 2. Dependencias ----------
if (-not (Test-Path (Join-Path $raiz "node_modules"))) {
  Passo "Instalando dependencias (so na primeira vez, leva um minuto)"
  & npm install
  if ($LASTEXITCODE -ne 0) { Falha "npm install falhou - veja a mensagem acima." }
} else {
  Passo "Dependencias ja instaladas"
}

# ---------- 3. .env ----------
$envPath = Join-Path $raiz ".env"
if (-not (Test-Path $envPath)) {
  Copy-Item (Join-Path $raiz ".env.example") $envPath
  Write-Host "Criei o .env a partir do .env.example"
}
$conteudo = [IO.File]::ReadAllText($envPath)

function Valor($nome) {
  $m = [regex]::Match($conteudo, "(?m)^$nome=(.*)$")
  if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return "" }
}
function Gravar($nome, $valor) {
  if ([regex]::IsMatch($conteudo, "(?m)^$nome=")) {
    $script:conteudo = [regex]::Replace($conteudo, "(?m)^$nome=.*$", "$nome=$valor")
  } else {
    $script:conteudo = $conteudo.TrimEnd() + "`n$nome=$valor`n"
  }
}

if (-not (Valor "TWITCH_CLIENT_ID")) {
  Passo "Credenciais do app da Twitch"
  Write-Host "Abra dev.twitch.tv/console > 'Boss Raid live' > Gerenciar."
  Write-Host "Confira: Tipo de cliente = Confidencial, e a URL de redirecionamento"
  Write-Host "http://localhost:3000/auth/twitch/callback (a da sua tela ja esta certa)."
  do { $id = (Read-Host "Cole o ID do cliente").Trim() } while (-not $id)
  Gravar "TWITCH_CLIENT_ID" $id
}

if (-not (Valor "TWITCH_CLIENT_SECRET")) {
  Write-Host "Na mesma tela, clique em 'Novo segredo' e copie (ele so aparece uma vez)."
  do {
    $seguro = Read-Host "Cole o segredo do cliente (nao aparece enquanto digita)" -AsSecureString
    $segredo = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)).Trim()
  } while (-not $segredo)
  Gravar "TWITCH_CLIENT_SECRET" $segredo
}

# UTF-8 sem BOM: e o que o dotenv espera.
[IO.File]::WriteAllText($envPath, $conteudo, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ".env pronto (as chaves de criptografia se geram sozinhas na primeira subida)"

# ---------- 4. Porta ----------
$ocupada = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($ocupada) {
  $processo = Get-Process -Id $ocupada[0].OwningProcess -ErrorAction SilentlyContinue
  Falha "A porta 3000 ja esta em uso por '$($processo.ProcessName)' (PID $($ocupada[0].OwningProcess)). Se for o SubPack, pare ele com Ctrl+C na janela dele e rode este script de novo."
}

# ---------- 5. Subir ----------
Passo "Subindo o Boss Raid (Ctrl+C para parar)"

# Abre o navegador assim que o servidor responder, sem travar esta janela.
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
  "-NoProfile", "-Command",
  "for (`$i = 0; `$i -lt 60; `$i++) { try { Invoke-WebRequest -UseBasicParsing http://localhost:3000/saude | Out-Null; Start-Process 'http://localhost:3000/entrar'; break } catch { Start-Sleep -Seconds 1 } }"
)

& npm start
