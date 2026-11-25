//! poker: a Texas hold'em table (play chips) whose dealer is the host.
//!
//! One request in (JSON), one reply out. The reply is several lines:
//!   line 1          the answer to the caller, JSON
//!   one per seat    the 32-character player token, then that player's view of the table, JSON
//!   last line       32 zeros, then the view a spectator gets
//! A player's view contains their own two cards and nobody else's, so the host can hand
//! each browser only its own line.
//!
//! Host protocol: ptr = request(len); host writes the request at ptr; n = handle(len);
//! ptr = response(). The program asks the host for randomness (env.ship_entropy, 64 bits,
//! twice per hand) to shuffle the deck.
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;

pub const SEATS: usize = 8;
pub const BUY_IN: u32 = 1000;
pub const SMALL_BLIND: u32 = 5;
pub const BIG_BLIND: u32 = 10;
const SPECTATOR: &str = "00000000000000000000000000000000";

// ---------------------------------------------------------------- cards and hand ranking

/// cards are 0..52: rank = c / 4 (0 is a two, 12 is an ace), suit = c % 4
pub fn card_name(c: u8) -> String {
    let r = b"23456789TJQKA"[(c / 4) as usize] as char;
    let s = b"cdhs"[(c % 4) as usize] as char;
    format!("{r}{s}")
}

pub const HAND_NAMES: [&str; 9] = ["High card", "Pair", "Two pair", "Three of a kind", "Straight",
    "Flush", "Full house", "Four of a kind", "Straight flush"];

/// score of exactly five cards; a higher score beats a lower one, equal scores tie
pub fn score5(cards: &[u8; 5]) -> u32 {
    let mut counts = [0u8; 13];
    for c in cards { counts[(c / 4) as usize] += 1; }
    let flush = cards.iter().all(|c| c % 4 == cards[0] % 4);
    // ranks ordered by how many of them there are, then by rank, highest first
    let mut groups: Vec<(u8, u8)> = (0..13u8).filter(|r| counts[*r as usize] > 0).map(|r| (counts[r as usize], r)).collect();
    groups.sort_by(|a, b| b.cmp(a));
    let distinct = groups.len() == 5;
    let hi = groups.iter().map(|g| g.1).max().unwrap();
    let lo = groups.iter().map(|g| g.1).min().unwrap();
    let wheel = distinct && counts[12] == 1 && counts[0] == 1 && counts[1] == 1 && counts[2] == 1 && counts[3] == 1;
    let straight = (distinct && hi - lo == 4) || wheel;
    let straight_high = if wheel { 3 } else { hi };
    let category = if straight && flush { 8 }
        else if groups[0].0 == 4 { 7 }
        else if groups[0].0 == 3 && groups[1].0 == 2 { 6 }
        else if flush { 5 }
        else if straight { 4 }
        else if groups[0].0 == 3 { 3 }
        else if groups[0].0 == 2 && groups[1].0 == 2 { 2 }
        else if groups[0].0 == 2 { 1 }
        else { 0 };
    let mut score = category as u32;
    if straight {
        score = (score << 20) | ((straight_high as u32) << 16);
    } else {
        for i in 0..5 { score = (score << 4) | groups.get(i).map(|g| g.1 as u32).unwrap_or(0); }
    }
    score
}

/// best five-card score out of five, six or seven cards
pub fn best_score(cards: &[u8]) -> u32 {
    let n = cards.len();
    let mut best = 0;
    for a in 0..n { for b in a + 1..n { for c in b + 1..n { for d in c + 1..n { for e in d + 1..n {
        best = best.max(score5(&[cards[a], cards[b], cards[c], cards[d], cards[e]]));
    }}}}}
    best
}

pub fn hand_name(score: u32) -> &'static str { HAND_NAMES[(score >> 20) as usize] }

// ---------------------------------------------------------------- randomness

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" { fn ship_entropy() -> i64; }

#[cfg(target_arch = "wasm32")]
fn host_entropy() -> u64 { unsafe { ship_entropy() as u64 } }

#[cfg(not(target_arch = "wasm32"))]
fn host_entropy() -> u64 { 0x1234_5678_9abc_def0 }

struct Rng([u64; 4]);
impl Rng {
    fn new(a: u64, b: u64, hand: u64) -> Rng {
        let mut x = a ^ b.rotate_left(32) ^ hand.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        let mut next = || { x = x.wrapping_add(0x9e37_79b9_7f4a_7c15); let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9); z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb); z ^ (z >> 31) };
        Rng([next() ^ b, next(), next() ^ a, next()])
    }
    fn next(&mut self) -> u64 {
        let s = &mut self.0;
        let out = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 17;
        s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = s[3].rotate_left(45);
        out
    }
    /// uniform in 0..n, no modulo bias
    fn below(&mut self, n: u64) -> u64 {
        let limit = u64::MAX - (u64::MAX % n);
        loop { let x = self.next(); if x < limit { return x % n; } }
    }
}

// ---------------------------------------------------------------- splitting the money

/// Split what everyone put in (`totals`) among the players still in (`live`), best `scores` first.
/// There is one pot per distinct amount put in, open to the live players who put in at least that
/// much; neighbouring pots open to the same players are one pot. A pot nobody can claim goes with
/// the next one that somebody can. Ties split evenly, odd chips going to the earliest in `order`.
/// Produces (pot size, winners, what each winner gets) per pot.
pub fn pots(totals: &[u32; SEATS], live: &[bool; SEATS], scores: &[u32; SEATS], order: &[usize]) -> Vec<(u32, Vec<usize>, Vec<u32>)> {
    let mut levels: Vec<u32> = totals.iter().copied().filter(|t| *t > 0).collect();
    levels.sort(); levels.dedup();
    let mut raw: Vec<(u32, Vec<usize>)> = vec![];
    let (mut prev, mut carry) = (0, 0);
    for level in levels {
        let amount: u32 = totals.iter().map(|t| (*t).min(level) - (*t).min(prev)).sum::<u32>() + carry;
        let open: Vec<usize> = (0..SEATS).filter(|i| live[*i] && totals[*i] >= level).collect();
        prev = level; carry = 0;
        match raw.last_mut() {
            Some(last) if open.is_empty() || last.1 == open => last.0 += amount,
            _ if open.is_empty() => carry = amount,
            _ => raw.push((amount, open)),
        }
    }
    raw.into_iter().map(|(amount, open)| {
        let best = open.iter().map(|i| scores[*i]).max().unwrap();
        let winners: Vec<usize> = order.iter().copied().filter(|i| open.contains(i) && scores[*i] == best).collect();
        let n = winners.len() as u32;
        let shares = (0..n).map(|k| amount / n + if k < amount % n { 1 } else { 0 }).collect();
        (amount, winners, shares)
    }).collect()
}

// ---------------------------------------------------------------- the table

#[derive(Clone, Default)]
pub struct Seat {
    pub token: String,
    pub name: String,
    pub chips: u32,
    pub bet: u32,        // put in during this betting round
    pub total: u32,      // put in during this hand
    pub hole: [u8; 2],
    pub in_hand: bool,   // was dealt cards this hand
    pub folded: bool,
    pub acted: bool,     // has acted since the last raise
    pub show: bool,      // cards are face up for everyone
    pub leaving: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Stage { Idle, Preflop, Flop, Turn, River }

#[derive(Default)]
pub struct Table {
    pub seats: [Option<Seat>; SEATS],
    pub button: usize,
    pub stage: Option<Stage>,
    pub board: Vec<u8>,
    deck: Vec<u8>,
    pub to_act: Option<usize>,
    pub current_bet: u32,
    pub min_raise: u32,
    pub hand_no: u32,
    pub log: Vec<String>,
    pub results: Vec<Value>,
    pub cashed_out: u32, // chips taken away by players who left
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Req {
    Join { token: String, name: String },
    Leave { token: String },
    Deal { token: String },
    Act { token: String, action: String, #[serde(default)] amount: Option<u32> },
    Rebuy { token: String },
    Hello,
}

impl Table {
    pub fn stage(&self) -> Stage { self.stage.unwrap_or(Stage::Idle) }
    fn say(&mut self, line: String) { self.log.push(line); if self.log.len() > 40 { self.log.remove(0); } }
    fn remove(&mut self, i: usize) { if let Some(s) = self.seats[i].take() { self.cashed_out += s.chips; } }
    fn seat_of(&self, token: &str) -> Option<usize> {
        self.seats.iter().position(|s| s.as_ref().map(|s| s.token == token).unwrap_or(false))
    }
    fn s(&self, i: usize) -> &Seat { self.seats[i].as_ref().unwrap() }
    fn sm(&mut self, i: usize) -> &mut Seat { self.seats[i].as_mut().unwrap() }
    fn live(&self, i: usize) -> bool { self.seats[i].as_ref().map(|s| s.in_hand && !s.folded).unwrap_or(false) }
    fn can_act(&self, i: usize) -> bool { self.live(i) && self.s(i).chips > 0 }
    fn live_count(&self) -> usize { (0..SEATS).filter(|i| self.live(*i)).count() }
    /// seats after `from`, going round the table once
    fn after(from: usize) -> impl Iterator<Item = usize> { (1..=SEATS).map(move |k| (from + k) % SEATS) }
    pub fn pot(&self) -> u32 { self.seats.iter().flatten().map(|s| s.total).sum() }
    pub fn chips_in_play(&self) -> u32 { self.seats.iter().flatten().map(|s| s.chips + s.total).sum() }

    fn pay(&mut self, i: usize, amount: u32) -> u32 {
        let s = self.sm(i);
        let paid = amount.min(s.chips);
        s.chips -= paid; s.bet += paid; s.total += paid;
        paid
    }

    pub fn handle(&mut self, req: Req) -> Result<(), String> {
        match req {
            Req::Hello => Ok(()),
            Req::Join { token, name } => {
                if token.len() != 32 || token == SPECTATOR || !token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                    return Err("bad token".into());
                }
                if self.seat_of(&token).is_some() { return Err("you are already seated".into()); }
                let name: String = name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(16).collect();
                if name.is_empty() { return Err("pick a name".into()); }
                let free = (0..SEATS).find(|i| self.seats[*i].is_none()).ok_or("the table is full")?;
                self.seats[free] = Some(Seat { token, name: name.clone(), chips: BUY_IN, ..Default::default() });
                self.say(format!("{name} sits down with {BUY_IN}"));
                Ok(())
            }
            Req::Leave { token } => {
                let i = self.seat_of(&token).ok_or("you are not seated")?;
                let name = self.s(i).name.clone();
                self.say(format!("{name} leaves"));
                if self.stage() == Stage::Idle || !self.live(i) {
                    if self.s(i).in_hand && self.stage() != Stage::Idle { self.sm(i).leaving = true; } else { self.remove(i); }
                    return Ok(());
                }
                self.sm(i).leaving = true;
                self.sm(i).folded = true;
                if self.to_act == Some(i) { self.progress(i); }
                else if self.live_count() == 1 { self.finish(false); }
                Ok(())
            }
            Req::Rebuy { token } => {
                let i = self.seat_of(&token).ok_or("you are not seated")?;
                if self.s(i).chips > 0 || (self.s(i).in_hand && self.stage() != Stage::Idle) { return Err("you still have chips".into()); }
                self.sm(i).chips = BUY_IN;
                let name = self.s(i).name.clone();
                self.say(format!("{name} buys back in for {BUY_IN}"));
                Ok(())
            }
            Req::Deal { token } => {
                self.seat_of(&token).ok_or("sit down first")?;
                if self.stage() != Stage::Idle { return Err("a hand is already being played".into()); }
                self.deal()
            }
            Req::Act { token, action, amount } => {
                let i = self.seat_of(&token).ok_or("you are not seated")?;
                if self.stage() == Stage::Idle { return Err("no hand is being played".into()); }
                if self.to_act != Some(i) { return Err("it is not your turn".into()); }
                let name = self.s(i).name.clone();
                let owed = self.current_bet - self.s(i).bet;
                match action.as_str() {
                    "fold" => { self.sm(i).folded = true; self.say(format!("{name} folds")); }
                    "check" => { if owed > 0 { return Err(format!("you need to call {owed}")); } self.say(format!("{name} checks")); }
                    "call" => {
                        if owed == 0 { return Err("nothing to call".into()); }
                        let paid = self.pay(i, owed);
                        let all_in = self.s(i).chips == 0;
                        self.say(format!("{name} calls {paid}{}", if all_in { ", all in" } else { "" }));
                    }
                    "raise" => {
                        let to = amount.ok_or("say how much to raise to")?;
                        let max = self.s(i).bet + self.s(i).chips;
                        if to > max { return Err(format!("you only have {max}")); }
                        if to <= self.current_bet { return Err(format!("a raise must be more than {}", self.current_bet)); }
                        let all_in = to == max;
                        if to - self.current_bet < self.min_raise && !all_in {
                            return Err(format!("the smallest raise is to {}", self.current_bet + self.min_raise));
                        }
                        if to - self.current_bet >= self.min_raise { self.min_raise = to - self.current_bet; }
                        let need = to - self.s(i).bet;
                        self.pay(i, need);
                        self.current_bet = to;
                        for j in 0..SEATS { if j != i && self.seats[j].is_some() { self.sm(j).acted = false; } }
                        let bet = owed == 0 && self.stage() != Stage::Preflop && to == need + 0 && self.s(i).bet == to;
                        self.say(format!("{name} {}{to}{}", if bet { "bets " } else { "raises to " }, if all_in { ", all in" } else { "" }));
                    }
                    _ => return Err("unknown action".into()),
                }
                self.sm(i).acted = true;
                self.progress(i);
                Ok(())
            }
        }
    }

    fn deal(&mut self) -> Result<(), String> {
        let ready: Vec<usize> = (0..SEATS).filter(|i| self.seats[*i].as_ref().map(|s| s.chips > 0).unwrap_or(false)).collect();
        if ready.len() < 2 { return Err("need at least two players with chips".into()); }
        self.hand_no += 1;
        let (a, b) = (host_entropy(), host_entropy());
        let mut rng = Rng::new(a, b, self.hand_no as u64);
        self.deck = (0..52).collect();
        for k in (1..52usize).rev() { let j = rng.below(k as u64 + 1) as usize; self.deck.swap(k, j); }
        self.board.clear(); self.results.clear();
        for i in 0..SEATS {
            if let Some(s) = self.seats[i].as_mut() {
                s.bet = 0; s.total = 0; s.folded = false; s.acted = false; s.show = false; s.in_hand = s.chips > 0;
            }
        }
        self.button = Self::after(self.button).find(|i| ready.contains(i)).unwrap();
        let next = |from: usize| Self::after(from).find(|i| ready.contains(i)).unwrap();
        // heads up the button posts the small blind
        let sb = if ready.len() == 2 { self.button } else { next(self.button) };
        let bb = next(sb);
        for i in ready.iter() { let c = [self.deck.pop().unwrap(), self.deck.pop().unwrap()]; self.sm(*i).hole = c; }
        self.stage = Some(Stage::Preflop);
        self.say(format!("Hand {}: {} has the button", self.hand_no, self.s(self.button).name));
        let p = self.pay(sb, SMALL_BLIND); let n = self.s(sb).name.clone(); self.say(format!("{n} posts {p}"));
        let p = self.pay(bb, BIG_BLIND); let n = self.s(bb).name.clone(); self.say(format!("{n} posts {p}"));
        self.current_bet = BIG_BLIND; self.min_raise = BIG_BLIND;
        self.to_act = None;
        self.progress(bb);
        Ok(())
    }

    /// after anything changes: end the hand, move to the next player, or deal the next street
    fn progress(&mut self, from: usize) {
        if self.live_count() == 1 { return self.finish(false); }
        let next = Self::after(from).find(|i| self.can_act(*i) && (!self.s(*i).acted || self.s(*i).bet < self.current_bet));
        // a lone player with chips has nobody left to bet against, once they have matched the bet
        let able = (0..SEATS).filter(|i| self.can_act(*i)).count();
        if let Some(i) = next {
            if !(able == 1 && self.s(i).bet >= self.current_bet) { self.to_act = Some(i); return; }
        }
        // the betting round is over
        loop {
            for i in 0..SEATS { if let Some(s) = self.seats[i].as_mut() { s.bet = 0; s.acted = false; } }
            self.current_bet = 0; self.min_raise = BIG_BLIND; self.to_act = None;
            let (stage, cards) = match self.stage() {
                Stage::Preflop => (Stage::Flop, 3), Stage::Flop => (Stage::Turn, 1), Stage::Turn => (Stage::River, 1),
                _ => return self.finish(true),
            };
            self.stage = Some(stage);
            for _ in 0..cards { let c = self.deck.pop().unwrap(); self.board.push(c); }
            let shown: Vec<String> = self.board.iter().map(|c| card_name(*c)).collect();
            self.say(format!("{:?}: {}", stage, shown.join(" ")));
            if (0..SEATS).filter(|i| self.can_act(*i)).count() >= 2 {
                self.to_act = Self::after(self.button).find(|i| self.can_act(*i));
                return;
            }
            // everyone left is all in (or all but one): run the rest of the board out
        }
    }

    fn finish(&mut self, showdown: bool) {
        if showdown { for i in 0..SEATS { if self.live(i) { self.sm(i).show = true; } } }
        let mut totals = [0u32; SEATS]; let mut live = [false; SEATS]; let mut scores = [0u32; SEATS];
        for i in 0..SEATS {
            if let Some(s) = &self.seats[i] {
                if !s.in_hand { continue; }
                totals[i] = s.total; live[i] = !s.folded;
                if showdown && live[i] { let mut cards = self.board.clone(); cards.extend(s.hole); scores[i] = best_score(&cards); }
            }
        }
        let order: Vec<usize> = Self::after(self.button).collect();
        for (amount, winners, shares) in pots(&totals, &live, &scores, &order) {
            for (w, share) in winners.iter().zip(shares) { self.sm(*w).chips += share; }
            let names: Vec<String> = winners.iter().map(|w| self.s(*w).name.clone()).collect();
            let hand = if showdown { hand_name(scores[winners[0]]) } else { "" };
            self.say(if showdown { format!("{} wins {amount} with {}", names.join(" and "), hand.to_lowercase()) }
                     else { format!("{} wins {amount}", names.join(" and ")) });
            self.results.push(json!({"amount": amount, "winners": names, "hand": hand}));
        }
        for i in 0..SEATS {
            if let Some(s) = self.seats[i].as_mut() { s.bet = 0; s.total = 0; s.acted = false; }
            if self.seats[i].as_ref().map(|s| s.leaving).unwrap_or(false) { self.remove(i); }
        }
        self.stage = Some(Stage::Idle); self.to_act = None; self.current_bet = 0;
    }

    /// what one viewer may see; `viewer` is a seat number, or None for a spectator
    pub fn view(&self, viewer: Option<usize>) -> Value {
        let idle = self.stage() == Stage::Idle;
        let seats: Vec<Value> = (0..SEATS).map(|i| match &self.seats[i] {
            None => Value::Null,
            Some(s) => {
                let dealt = s.in_hand && (!idle || s.show);
                let cards: Vec<String> = if !dealt || (s.folded && viewer != Some(i)) { vec![] }
                    else if viewer == Some(i) || s.show { s.hole.iter().map(|c| card_name(*c)).collect() }
                    else { vec!["??".into(), "??".into()] };
                json!({"name": s.name, "chips": s.chips, "bet": s.bet, "folded": s.folded && s.in_hand && !idle,
                       "all_in": !idle && s.in_hand && !s.folded && s.chips == 0, "busted": s.chips == 0 && (idle || !s.in_hand),
                       "waiting": !idle && !s.in_hand, "cards": cards})
            }
        }).collect();
        let actions = match (viewer, self.to_act) {
            (Some(v), Some(t)) if v == t => {
                let s = self.s(v);
                let owed = self.current_bet - s.bet;
                let max = s.bet + s.chips;
                let min_to = (self.current_bet + self.min_raise).min(max);
                json!({"call": owed.min(s.chips), "can_check": owed == 0, "can_raise": max > self.current_bet && (0..SEATS).any(|j| j != v && self.can_act(j)),
                       "min_raise_to": min_to, "max_raise_to": max})
            }
            _ => Value::Null,
        };
        let ready = self.seats.iter().flatten().filter(|s| s.chips > 0).count();
        json!({
            "hand": self.hand_no, "stage": format!("{:?}", self.stage()).to_lowercase(),
            "board": self.board.iter().map(|c| card_name(*c)).collect::<Vec<_>>(),
            "pot": self.pot(), "current_bet": self.current_bet, "button": self.button, "to_act": self.to_act,
            "seats": seats, "you": viewer, "actions": actions, "results": self.results,
            "log": &self.log[self.log.len().saturating_sub(14)..],
            "can_deal": idle && viewer.is_some() && ready >= 2, "blinds": [SMALL_BLIND, BIG_BLIND],
        })
    }

    /// the whole reply: answer, then one line per seated player, then the spectator's line
    pub fn reply(&self, answer: &Value) -> String {
        let mut out = answer.to_string();
        for i in 0..SEATS {
            if let Some(s) = &self.seats[i] { out.push('\n'); out.push_str(&s.token); out.push_str(&self.view(Some(i)).to_string()); }
        }
        out.push('\n'); out.push_str(SPECTATOR); out.push_str(&self.view(None).to_string());
        out
    }
}

// ---------------------------------------------------------------- host interface

#[derive(Default)]
struct App { table: Table, inbuf: Vec<u8>, outbuf: Vec<u8> }
thread_local! { static APP: RefCell<App> = RefCell::new(App::default()); }

#[no_mangle]
pub extern "C" fn request(len: u32) -> *mut u8 {
    APP.with(|a| { let mut a = a.borrow_mut(); a.inbuf.resize(len as usize, 0); a.inbuf.as_mut_ptr() })
}

#[no_mangle]
pub extern "C" fn handle(len: u32) -> u32 {
    APP.with(|a| {
        let mut a = a.borrow_mut();
        let input = std::mem::take(&mut a.inbuf);
        let answer = match serde_json::from_slice::<Req>(&input[..len as usize]) {
            Ok(req) => match a.table.handle(req) { Ok(()) => json!({"ok": true}), Err(e) => json!({"ok": false, "error": e}) },
            Err(e) => json!({"ok": false, "error": e.to_string()}),
        };
        a.inbuf = input;
        a.outbuf = a.table.reply(&answer).into_bytes();
        a.outbuf.len() as u32
    })
}

#[no_mangle]
pub extern "C" fn response() -> *const u8 { APP.with(|a| a.borrow().outbuf.as_ptr()) }
