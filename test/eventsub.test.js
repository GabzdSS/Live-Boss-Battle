import { test } from "node:test";
import assert from "node:assert/strict";
import { traduzirEvento } from "../src/twitch/eventsub.js";

// Payloads no formato da documentacao do EventSub (campos que usamos).

test("resgate de recompensa vira gatilho com o id do resgate como ref", () => {
  const g = traduzirEvento(
    "channel.channel_points_custom_reward_redemption.add",
    {
      id: "17fa2df1-ad76-4804-bfa5-a40ef63efe63",
      broadcaster_user_id: "1337",
      user_id: "9001",
      user_login: "cooler_user",
      user_name: "Cooler_User",
      user_input: "",
      status: "unfulfilled",
      reward: { id: "92af127c-7326-4483-a52b-b0da0be61c01", title: "Ataque", cost: 100, prompt: "" },
      redeemed_at: "2020-07-15T17:16:03.17106713Z",
    },
    "msg-1"
  );
  assert.deepEqual(g, {
    origem: "resgate",
    ref: "resgate:17fa2df1-ad76-4804-bfa5-a40ef63efe63",
    redemptionId: "17fa2df1-ad76-4804-bfa5-a40ef63efe63",
    rewardId: "92af127c-7326-4483-a52b-b0da0be61c01",
    rewardTitulo: "Ataque",
    custo: 100,
    userId: "9001",
    login: "cooler_user",
    username: "Cooler_User",
  });
});

test("cheer usa o message_id como ref (cheer nao tem id proprio)", () => {
  const g = traduzirEvento(
    "channel.cheer",
    { is_anonymous: false, user_id: "1234", user_login: "cool_user", user_name: "Cool_User", bits: 1000, message: "pogchamp" },
    "befa7b53-d79d-478f-86b9-120f112b044e"
  );
  assert.equal(g.origem, "cheer");
  assert.equal(g.ref, "cheer:befa7b53-d79d-478f-86b9-120f112b044e");
  assert.equal(g.bits, 1000);
  assert.equal(g.userId, "1234");
  assert.equal(g.anonimo, false);
});

test("cheer anonimo causa dano mas nao tem quem ranquear", () => {
  const g = traduzirEvento(
    "channel.cheer",
    { is_anonymous: true, user_id: null, user_login: null, user_name: null, bits: 50, message: "" },
    "m-2"
  );
  assert.equal(g.anonimo, true);
  assert.equal(g.userId, null);
  assert.equal(g.username, "Anônimo");
  assert.equal(g.bits, 50);
});

test("tipo desconhecido e ignorado", () => {
  assert.equal(traduzirEvento("channel.follow", {}, "m-3"), null);
});
