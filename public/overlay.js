// Overlay do OBS: so a conexao. A animacao vai viver em overlay-anim.js
// (etapa 4), que a vitrine tambem vai usar - assim demo e producao nunca divergem.
//
// A URL do overlay e /overlay/<token secreto do canal>. O token identifica de
// qual canal esta fonte do OBS recebe os eventos - sem ele, o servidor recusa
// a conexao (em vez de mandar o chefao de outro canal pra tela).
const tokenDoCanal = window.location.pathname.split("/").filter(Boolean).pop();
const socket = io({ query: { overlay: tokenDoCanal } });

socket.on("connect", () => console.log("[overlay] conectado"));
socket.on("connect_error", (err) => console.error("[overlay] nao conectou:", err.message));
