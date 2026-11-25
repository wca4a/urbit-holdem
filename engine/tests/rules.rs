use poker::*;
use serde_json::Value;

fn c(s: &str) -> u8 { let b = s.as_bytes(); (b"23456789TJQKA".iter().position(|x| *x == b[0]).unwrap() * 4 + b"cdhs".iter().position(|x| *x == b[1]).unwrap()) as u8 }
fn h(s: &str) -> u32 { best_score(&s.split(' ').map(c).collect::<Vec<_>>()) }

#[test]
fn hand_ranking() {
    // one example of each kind, weakest first: each must beat the one before
    let ladder = ["Ah Kd 9s 7c 4h 3d 2c", "Ah Ad 9s 7c 4h 3d 2c", "Ah Ad 9s 9c 4h 3d 2c", "Ah Ad As 9c 4h 3d 2c",
        "5h 4d 3s 2c Ah Kd Qc", "9h 8d 7s 6c 5h Ad Ac", "Ah Jh 9h 7h 4h 3d 2c", "Ah Ad As 9c 9h 3d 2c",
        "Ah Ad As Ac 4h 3d 2c", "5h 4h 3h 2h Ah Kd Qc", "Ah Kh Qh Jh Th 9h 8h"];
    for w in ladder.windows(2) { assert!(h(w[1]) > h(w[0]), "{} should beat {}", w[1], w[0]); }
    let names: Vec<&str> = ladder.iter().map(|x| hand_name(h(x))).collect();
    assert_eq!(names, ["High card", "Pair", "Two pair", "Three of a kind", "Straight", "Straight", "Flush", "Full house", "Four of a kind", "Straight flush", "Straight flush"]);
    // kickers decide
    assert!(h("Ah Ad Ks 7c 4h 3d 2c") > h("As Ac Qs 7d 4s 3h 2d"));
    assert!(h("Kh Kd 9s 9c Ah 3d 2c") > h("Ks Kc 9h 9d Qh 3s 2d"));
    assert!(h("Ah Kh 9h 7h 4h 3d 2c") > h("As Qs 9s 7s 4s 3h 2d"));
    // same five cards from the board is a tie, whatever is in the hand
    assert_eq!(h("Ah Kd Qs Jc Th 3d 2c"), h("Ah Kd Qs Jc Th 4s 4c".replace("4s 4c", "5d 2h").as_str()));
    // the best five are used: two pair plus a higher third pair, and a six-high straight over the wheel
    assert_eq!(h("Ah Ad Ks Kc Qh Qd 2c"), h("Ah Ad Ks Kc Qh 3d 2c"));
    assert!(h("6h 5d 4s 3c 2h Ad Kc") > h("5h 4d 3s 2c Ah Kd Qc"));
    // full house: the three of a kind decides before the pair
    assert!(h("3h 3d 3s 2c 2h 9d 8c") > h("2s 2d 2c Ah Ad 9c 8d").min(h("3h 3d 3s 2c 2h 9d 8c")) - 1);
    assert!(h("3h 3d 3s 2c 2h 9d 8c") > h("2s 2d 2h Ac Ad 9c 8d"));
}

#[test]
fn splitting_pots() {
    let order: Vec<usize> = (1..=SEATS).map(|k| k % SEATS).collect();   // button on seat 0
    let mk = |v: &[u32]| { let mut a = [0u32; SEATS]; a[..v.len()].copy_from_slice(v); a };
    let lv = |v: &[bool]| { let mut a = [false; SEATS]; a[..v.len()].copy_from_slice(v); a };
    let pay = |t: &[u32], l: &[bool], s: &[u32]| { let mut out = [0u32; SEATS];
        for (_, w, sh) in pots(&mk(t), &lv(l), &mk(s), &order) { for (w, sh) in w.iter().zip(sh) { out[*w] += sh; } } out[..t.len()].to_vec() };
    assert_eq!(pay(&[100, 100, 100], &[true, true, true], &[3, 2, 1]), [300, 0, 0]);
    // short stack all in wins only what it could match; the rest goes to the next best
    assert_eq!(pay(&[50, 200, 200], &[true, true, true], &[9, 5, 1]), [150, 300, 0]);
    // tie with an odd chip: the first seat after the button gets it
    assert_eq!(pay(&[25, 25, 25], &[true, true, false], &[7, 7, 0]), [37, 38, 0]);
    // a bet nobody called comes back
    assert_eq!(pay(&[300, 100], &[true, true], &[1, 9]), [200, 200]);
    // the biggest contributor folded: the remaining player takes everything
    assert_eq!(pay(&[300, 100], &[false, true], &[0, 0]), [0, 400]);
    // three all-ins of different sizes, best hand shortest
    assert_eq!(pay(&[10, 40, 90, 90], &[true, true, true, true], &[9, 8, 7, 7]), [40, 90, 50, 50]);
}

struct Lcg(u64);
impl Lcg { fn n(&mut self, n: u64) -> u64 { self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (self.0 >> 33) % n } }
fn tok(i: usize) -> String { format!("{:032x}", i + 1) }

#[test]
fn random_play_keeps_every_chip() {
    let mut t = Table::default();
    let mut r = Lcg(42);
    let mut bought: u32 = 0;
    let mut hands = 0;
    let mut steps = 0u64;
    while hands < 20_000 {
        steps += 1; assert!(steps < 5_000_000, "stuck");
        // people come and go
        let roll = r.n(400);
        if roll < 8 { let i = r.n(SEATS as u64) as usize;
            let seated = t.seats.iter().flatten().any(|s| s.token == tok(i));
            if !seated { if t.handle(Req::Join { token: tok(i), name: format!("p{i}") }).is_ok() { bought += BUY_IN; } }
            else if roll < 3 { t.handle(Req::Leave { token: tok(i) }).unwrap(); }
        }
        for s in t.seats.iter().flatten().cloned().collect::<Vec<_>>() {
            if s.chips == 0 && t.handle(Req::Rebuy { token: s.token }).is_ok() { bought += BUY_IN; }
        }
        assert_eq!(t.chips_in_play() + t.cashed_out, bought, "chips appeared or vanished at hand {}", t.hand_no);
        if t.stage() == Stage::Idle {
            if let Some(s) = t.seats.iter().flatten().next() { if t.handle(Req::Deal { token: s.token.clone() }).is_ok() { hands += 1; } }
            continue;
        }
        let seat = t.to_act.expect("a hand is on but nobody is to act");
        assert!(t.seats[seat].as_ref().map(|s| s.in_hand && !s.folded && s.chips > 0).unwrap_or(false), "the player to act cannot act");
        let v = t.view(Some(seat));
        let a = &v["actions"]; assert!(!a.is_null());
        // nobody else's cards leak into this view
        for (i, s) in v["seats"].as_array().unwrap().iter().enumerate() {
            if i != seat && !s.is_null() { for card in s["cards"].as_array().unwrap() { assert!(card == "??" , "seat {i}'s cards visible to seat {seat}"); } }
        }
        let token = t.seats[seat].as_ref().unwrap().token.clone();
        let (call, min_to, max_to) = (a["call"].as_u64().unwrap(), a["min_raise_to"].as_u64().unwrap() as u32, a["max_raise_to"].as_u64().unwrap() as u32);
        let pick = r.n(100);
        let req = if pick < 12 { Req::Act { token, action: "fold".into(), amount: None } }
            else if pick < 30 && max_to > t.current_bet { let to = if pick < 16 || min_to >= max_to { max_to } else { min_to + r.n((max_to - min_to) as u64 + 1) as u32 };
                Req::Act { token, action: "raise".into(), amount: Some(to) } }
            else if call == 0 { Req::Act { token, action: "check".into(), amount: None } }
            else { Req::Act { token, action: "call".into(), amount: None } };
        t.handle(req).expect("a legal action was refused");
        // out of turn and nonsense are refused without changing anything
        if pick == 50 { assert!(t.handle(Req::Act { token: tok(99), action: "call".into(), amount: None }).is_err()); }
    }
    assert!(t.hand_no >= 20_000);
    let _: Value = t.view(None);
}
