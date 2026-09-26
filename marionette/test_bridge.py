"""Through the bridge: wait for the arm to reach ready, then run the self-test on all 6 joints."""
import asyncio, json
import aiohttp


async def main():
    async with aiohttp.ClientSession() as s, s.ws_connect("http://localhost:8000/ws") as ws:
        await ws.send_json({"type": "connect"})
        sent, last = False, None
        while True:
            m = json.loads((await ws.receive(timeout=90)).data)
            if m["type"] == "status" and m["msg"] != last:
                last = m["msg"]
                print(f"[{m['robot']}/{m['mode']}] {m['msg']}")
                if m["robot"] == "live" and m["mode"] == "idle":
                    if sent:
                        return
                    sent = True
                    await ws.send_json({"type": "selftest"})
                elif m["robot"] in ("error", "sim") and m["mode"] == "idle":
                    return
            elif m["type"] == "selftest":
                r = m["results"][-1]
                print(f"   {'PASS' if r['ok'] else 'FAIL'} {r['joint']:14s} moved {r['moved']:+6.1f} of {r['want']:+.1f}")


asyncio.run(main())
