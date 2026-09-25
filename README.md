# Boss Raid

Um chefão aparece no overlay da live (browser source do OBS) com barra de vida,
e o chat se junta para derrotá-lo gastando pontos do canal e bits.

Produto irmão do SubPack (repositório `CardPacks`): mesma stack, mesmo login
com a Twitch, mesmo jeito de servir o overlay. O desenho completo e as etapas
estão em [`ARQUITETURA.md`](ARQUITETURA.md).

## Rodar no Windows (jeito rápido)

Com o repositório clonado, dê dois cliques em **`rodar-local.bat`**. Ele confere
o Node, instala as dependências, pede o Client ID e o segredo do app da Twitch
(só na primeira vez), sobe o servidor e abre o navegador em `/entrar`.
Para parar: **Ctrl+C** na janela.

## Rodar (qualquer sistema)

```bash
npm install
cp .env.example .env     # preencha TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET
npm start
```

Sem `DATABASE_URL` o banco é local (PGlite, em `data/pg`) e as chaves de
criptografia se geram sozinhas no `.env`. Mesmas duas regras do SubPack:
**um processo por vez** no banco de dev, e **encerre com Ctrl+C** (nunca matando o
processo): o Postgres em WASM não se recupera de crash. Se acontecer, apague
`data/pg`.

- Entrar: `http://localhost:3000/entrar`
- Painel: `http://localhost:3000/painel`
- Canal falso já logado, sem Twitch: `http://localhost:3000/dev/canal-de-teste?login=fulano`
- Testes: `npm test`

## App da Twitch

Crie um app **próprio** em <https://dev.twitch.tv/console> (não reaproveite o do
SubPack): a Twitch só deixa reembolsar resgates de recompensas criadas pelo mesmo
Client ID. Tipo **Confidencial**, com estes redirects:

- `http://localhost:3000/auth/twitch/callback`
- `https://SEU-DOMINIO/auth/twitch/callback`

Escopos pedidos à streamer: `channel:manage:redemptions`, `bits:read`,
`user:read:email`, `chat:read`, `chat:edit`. Pontos do canal e bits só existem
em canais **Afiliados ou Parceiros**; em outros canais o painel mostra isso e o
modo de teste continua funcionando.

## Deploy

Igual ao SubPack (Fly.io, uma máquina, sem auto-stop): `Dockerfile` e
`fly.toml` já estão aqui, e o roteiro é o `DEPLOY.md` de lá.
