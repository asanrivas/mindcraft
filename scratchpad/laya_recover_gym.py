"""
Laya (local, non-generative) on the BUILDER STALL-RECOVERY decision, against the same seven
cases jev-1.13 answered 7/7 in scratchpad/jev_recover_probe.mjs.

    .venv-laya/bin/python scratchpad/laya_recover_gym.py laya   # local, no network
    python3 scratchpad/laya_recover_gym.py jev                    # cloud, needs TYPESAFE_API_KEY

Needs no Minecraft server, no RCON and no agent. It measures one thing: when the builder has
placed nothing for a long run of attempts, can a model pick the right recovery out of the
failure strings the builder ALREADY has - without a cloud round trip.

WHY THREE VARIANTS, AND NOT ONE. The laya-integration skill states two rules that the Jev
question breaks on purpose, so "Laya scored worse than Jev" would be uninterpretable from a
single column - it could be the model, the phrasing, or the state:

  A  ACTION + NUMBERS   the Jev question verbatim: "which recovery should the builder take",
                        state carrying `sinceLastPlaced: 41` and `32x "..."` tallies.
  B  ACTION + WORDS     same question, numbers resolved to words in code ("a long run of
                        attempts", "every attempt failed the same way").
  C  PERCEPTION + WORDS what the skill actually asks for: the model says WHAT IS HAPPENING,
                        and the mapping from situation to recovery lives in code below.

C is the shape we would ship if the numbers support it, because it also matches this repo's
own rule: measure the thing you are concluding about. "The bot cannot move at all" is an
observation the failure text supports. "Return to the station above the build" is a decision
about OUR code, which the model has no way to know and no business making.

Baselines on these same 7 cases:
  jev-1.13 cloud, ACTION + NUMBERS   7/7, 267-1300ms per call, ~$0.00015 a call
"""
import json, os, sys, time, urllib.request

# ---- the seven cases, taken from logs/service.log on 2026-09-22 ----------------------------
# `numeric` is the state as the builder holds it. `worded` is the same facts with every count
# and magnitude resolved in code, which is what the skill asks for.
CASES = [
    dict(
        label="wedged",
        numeric={"sinceLastPlaced": 41,
                 "recent_failures": ['32x "flyNear failed: blocked@4605.5,64.4,4628.5 | flew '
                                     'short by 3.1, eye 4.8 | wedged, rose 1.9 | budget spent | '
                                     'no route (sealed or out of range)"',
                                     '9x "out of reach (no clear hover within range)"'],
                 "note": "the bot position has not changed to twelve decimal places in 4 minutes"},
        worded="The bot has placed nothing for a long run of attempts. Every attempt failed the "
               "same way: it tried to fly to the block, was blocked at once, moved almost "
               "nowhere, and reported no route. Its position has not changed at all for "
               "minutes. It is inside the walls it has been building.",
        want_situation="body_stuck", want_action=("free_and_restation", "defer_region"),
    ),
    dict(
        label="sealed room",
        numeric={"sinceLastPlaced": 60,
                 "recent_failures": ['60x "out of reach (no clear hover within range)"'],
                 "note": "the bot flies normally between cells but every target cell is inside "
                         "the finished walls"},
        worded="The bot has placed nothing for a long run of attempts. It flies freely from "
               "place to place with no trouble, but every block it wants to place sits inside "
               "a room whose walls are already finished, and it cannot get close enough to "
               "any of them.",
        want_situation="walled_in", want_action=("defer_region", "free_and_restation"),
    ),
    dict(
        label="no support",
        numeric={"sinceLastPlaced": 55,
                 "recent_failures": ['55x "no solid neighbor to place against"'],
                 "note": "all failing cells are at the same height, above open air"},
        worded="The bot has placed nothing for a long run of attempts. It reaches every spot "
               "easily and holds the right material, but each spot floats in open air with "
               "nothing solid beside or beneath it to attach a block to. All of them sit at "
               "the same height.",
        want_situation="nothing_to_build_on", want_action=("defer_layer",),
    ),
    dict(
        label="no item",
        numeric={"sinceLastPlaced": 30,
                 "recent_failures": ['30x "no item stripped_dark_oak_wood"'],
                 "note": "the bot reaches every cell without trouble"},
        worded="The bot has placed nothing for a long run of attempts. It reaches every spot "
               "without trouble and there is solid ground to build against, but it is not "
               "carrying the wood the blueprint calls for and has none left anywhere in its "
               "bags.",
        want_situation="empty_handed", want_action=("restock",),
    ),
    dict(
        label="server no",
        numeric={"sinceLastPlaced": 200,
                 "recent_failures": ['200x "refused by server (ack Nms)"'],
                 "note": "the bot reaches every cell and holds the right item"},
        worded="The bot has placed nothing for a very long run of attempts. It reaches every "
               "spot, holds the right block, and has something solid to build against, yet the "
               "server rejects every single placement it sends and gives no reason.",
        want_situation="server_refusing", want_action=("stop_and_report",),
    ),
    dict(
        label="terrain",
        numeric={"sinceLastPlaced": 24,
                 "recent_failures": ['24x "cell occupied by grass_block, dig refused"'],
                 "note": "the footprint is on a hillside"},
        worded="The bot has placed nothing for a long run of attempts. Every spot it wants to "
               "build in is already filled with the grass and dirt of the hillside the "
               "building stands on, and that ground has to come out before anything can go in.",
        want_situation="ground_in_way", want_action=("clear_terrain",),
    ),
    dict(
        label="healthy",
        numeric={"sinceLastPlaced": 3,
                 "recent_failures": ['2x "chunk not loaded"',
                                     '1x "refused by server (ack Nms)"'],
                 "note": "570 of 8285 cells placed so far, most attempts succeed"},
        worded="The bot is placing blocks steadily and most attempts succeed. A couple of "
               "recent ones failed because the world had not finished loading around it, and "
               "one was rejected by the server. It has just carried on and kept building.",
        want_situation="working_fine", want_action=("continue",),
    ),
]

# ---- variant A/B: ask for the ACTION (the Jev question) -------------------------------------
# Short descriptions on purpose: every option is cut at 48 tokens and the whole option list
# shares 192 tokens on the English checkpoint, so the prose the cloud model got would be
# silently truncated here.
ACTION_CRITERIA = {
    "continue":           "blocks are going up; the failures are incidental",
    "free_and_restation": "the body is stuck and must be freed first",
    "defer_region":       "these spots are walled in; build elsewhere",
    "defer_layer":        "nothing exists yet to attach these to",
    "clear_terrain":      "natural ground must be dug out first",
    "restock":            "the bot needs to refill its building material",
    "stop_and_report":    "nothing will fix this; end the build",
}
ACTION_INSTRUCTIONS = ("A Minecraft bot building a large structure has stopped making progress. "
                       "Which single recovery should it take next?")

# ---- variant C: ask what is HAPPENING, and map to an action in code -------------------------
SITUATION_CRITERIA = {
    "working_fine":        "blocks are going up steadily",
    "body_stuck":          "the bot cannot move from where it is",
    "walled_in":           "the bot moves freely but cannot get near the spots",
    "nothing_to_build_on": "the spots have nothing solid to attach to",
    "empty_handed":        "the bot does not have the material",
    "server_refusing":     "the server rejects placements that should work",
    "ground_in_way":       "existing ground already fills the spots",
}
SITUATION_INSTRUCTIONS = ("A Minecraft bot is building a large structure. What does this report "
                          "say is happening to it?")

# The policy. It lives in code, it is readable, and it is the part a person argues with - which
# is the whole reason for asking perception rather than asking for the verdict.
SITUATION_TO_ACTION = {
    "working_fine":        "continue",
    "body_stuck":          "free_and_restation",
    "walled_in":           "defer_region",
    "nothing_to_build_on": "defer_layer",
    "empty_handed":        "restock",
    "server_refusing":     "stop_and_report",
    "ground_in_way":       "clear_terrain",
}

# ---- the two backends ------------------------------------------------------------------------
# Same cases, same variants, one script: a column that only exists in one file cannot be
# compared against the other, and comparing them is the entire point.
BACKEND = sys.argv[1] if len(sys.argv) > 1 else "laya"

if BACKEND == "laya":
    import laya
    print("loading laya (English checkpoint)...", flush=True)
    t0 = time.time()
    agent = laya.load("convaiinnovations/laya")
    print(f"loaded in {time.time() - t0:.1f}s", flush=True)
    # Warm up: the first call at a new batch shape compiles kernels and is several times
    # slower, which would otherwise land entirely on case 1 of variant A and read as latency.
    agent.predict("warm up", {"w": {"type": "choice", "instructions": "Is this a warm up?",
                                    "criteria": {"yes": "it is", "no": "it is not"}}})

    def ask(state, instructions, criteria):
        r = agent.predict(state, {"q": {"type": "choice", "instructions": instructions,
                                        "criteria": criteria}})["answers"]["q"]
        return r["choice"], r["probabilities"], r["confidence"]
else:
    KEY = os.environ.get("TYPESAFE_API_KEY")
    if not KEY:
        sys.exit("TYPESAFE_API_KEY is not set - the jev column needs it. Nothing measured.")

    def ask(state, instructions, criteria):
        body = json.dumps({"state": state, "model": "jev-latest",
                           "questions": {"q": {"type": "choice", "instructions": instructions,
                                               "criteria": criteria}}}).encode()
        req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=body,
                                     headers={"Authorization": f"Bearer {KEY}",
                                              "Content-Type": "application/json"})
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())["answers"]["q"]
        return r["choice"], r.get("probabilities", {}), r.get("confidence", float("nan"))

VARIANTS = [
    ("A ACTION+NUMBERS", "numeric", ACTION_INSTRUCTIONS, ACTION_CRITERIA, "action"),
    ("B ACTION+WORDS",   "worded",  ACTION_INSTRUCTIONS, ACTION_CRITERIA, "action"),
    ("C PERCEPT+WORDS",  "worded",  SITUATION_INSTRUCTIONS, SITUATION_CRITERIA, "situation"),
]

summary = {}
for name, state_key, instructions, criteria, kind in VARIANTS:
    print(f"\n===== {BACKEND.upper()} {name} =====")
    hits, times = 0, []
    for c in CASES:
        state = c[state_key]
        t = time.time()
        raw, probabilities, confidence = ask(state, instructions, criteria)
        ms = (time.time() - t) * 1000
        times.append(ms)
        # Variant C answers a SITUATION; the recovery is ours to derive, not the model's.
        action = SITUATION_TO_ACTION[raw] if kind == "situation" else raw
        ok = action in c["want_action"]
        hits += ok
        top = " ".join(f"{k}={v:.2f}" for k, v in
                       sorted(probabilities.items(), key=lambda kv: -kv[1])[:3])
        shown = raw if kind == "action" else f"{raw} -> {action}"
        print(f"  {'ok  ' if ok else 'MISS'} {c['label']:<12} -> {shown:<34} "
              f"conf={confidence:.2f} {ms:6.0f}ms  [{top}]")
    summary[name] = (hits, sum(times) / len(times))
    print(f"  {name}: {hits}/{len(CASES)}   median-ish {sum(times)/len(times):.0f}ms/call")

# ---- variant D: one NOUL per situation, all in ONE forward pass -----------------------------
# The skill calls a long `choice` list Laya's weakest shape and says to use one noul per label
# when several may apply; every question in a single predict() shares one forward pass, so
# seven yes/no questions cost exactly one call. If the 7-way collapse in variant C is the
# option list rather than the model, this is where it shows.
NOULS = {
    "working_fine":        "Is the bot managing to place blocks?",
    "body_stuck":          "Is the bot unable to move from where it is?",
    "walled_in":           "Can the bot move around freely, but not get close to the spots it needs?",
    "nothing_to_build_on": "Do the spots lack anything solid to attach a block to?",
    "empty_handed":        "Is the bot missing the material it needs?",
    "server_refusing":     "Is the server rejecting placements that ought to work?",
    "ground_in_way":       "Is existing ground already filling the spots?",
}

print(f"\n===== {BACKEND.upper()} D NOULS+WORDS =====")
hits, times = 0, []
for c in CASES:
    t = time.time()
    if BACKEND == "laya":
        r = agent.predict(c["worded"], {k: {"type": "noul", "instructions": v}
                                        for k, v in NOULS.items()})["answers"]
        probs = {k: v["noul"] for k, v in r.items()}
    else:
        body = json.dumps({"state": c["worded"], "model": "jev-latest",
                           "questions": {k: {"type": "noul", "instructions": v}
                                         for k, v in NOULS.items()}}).encode()
        req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=body,
                                     headers={"Authorization": f"Bearer {os.environ['TYPESAFE_API_KEY']}",
                                              "Content-Type": "application/json"})
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())["answers"]
        probs = {k: v["noul"] for k, v in r.items()}
    ms = (time.time() - t) * 1000
    times.append(ms)
    raw = max(probs, key=probs.get)
    action = SITUATION_TO_ACTION[raw]
    ok = action in c["want_action"]
    hits += ok
    top = " ".join(f"{k}={v:.2f}" for k, v in sorted(probs.items(), key=lambda kv: -kv[1])[:3])
    print(f"  {'ok  ' if ok else 'MISS'} {c['label']:<12} -> {raw + ' -> ' + action:<34} "
          f"{ms:6.0f}ms  [{top}]")
summary["D NOULS+WORDS"] = (hits, sum(times) / len(times))
print(f"  D NOULS+WORDS: {hits}/{len(CASES)}   median-ish {sum(times)/len(times):.0f}ms/call")

print("\n--- same 7 cases ---")
for name, (hits, ms) in summary.items():
    print(f"  {BACKEND} {name}: {hits}/7, {ms:.0f}ms/call")

json.dump({k: {"hits": v[0], "ms": round(v[1])} for k, v in summary.items()},
          open(f"scratchpad/laya_recover_gym.{BACKEND}.json", "w"), indent=2)
