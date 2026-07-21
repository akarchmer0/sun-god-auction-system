export const AUCTIONEER_PERSONALITIES = Object.freeze({
  classic: { name: "Lucy Classic", description: "Warm, witty, and in control." },
  hype: { name: "Stadium Pulse", description: "Rapid play-by-play and match-night drama." },
  pro: { name: "League Pro", description: "Fast, direct, and commissioner-focused." }
});

const LINES = {
  classic: {
    nomination: (player) => [
      `Next on the block: ${player.name}, ${player.position}, ${player.nflTeam}. We open at one dollar. Who wants in?`,
      `${player.name} is up! ${player.position} for ${player.nflTeam}. One dollar gets us started. Let's see those bids.`,
      `All eyes up front. It's ${player.name}, ${player.position}, ${player.nflTeam}. Opening at one. Who's first?`
    ],
    phoneBid: ({ amount, manager, nextAmount }) => [`${manager} fires in at ${amount}! Now give me ${nextAmount}.`, `${amount} from ${manager}! Looking for ${nextAmount}.`, `${manager} takes it to ${amount}! Who has ${nextAmount}?`],
    bid: ({ amount, manager, nextAmount }) => [`${amount} dollars with ${manager}. Do I hear ${nextAmount}?`, `${manager} has it at ${amount}. Looking for ${nextAmount}.`, `${amount} to ${manager}! Who moves it to ${nextAmount}?`],
    openingPatter: (player) => [
      `${player.name} is on the block. One dollar opens the door—who steps through?`,
      `The room studies ${player.name}. The price is one, the opportunity is now.`,
      `Still looking for the first move on ${player.name}. One dollar puts you in front.`,
      `${player.position} talent on the table, and all it takes is one dollar to start.`,
      `Lucy scans the room. ${player.name} is waiting, and the opening is only one.`
    ],
    patter: ({ player, amount, manager, nextAmount, phase, suggestedValue }) => [
      `${manager} controls ${player.name} at ${amount}. ${nextAmount} takes the lead—who answers?`,
      `${amount} is the number, ${nextAmount} is the question, and the whole room has an answer to give.`,
      `${player.name} with ${manager} at ${amount}. One move changes everything; ${nextAmount} is the door.`,
      `The bid sits at ${amount}, but it does not feel safe. ${nextAmount} moves this auction again.`,
      `Eyes on the room, eyes on ${player.name}. ${manager} leads at ${amount}, looking for ${nextAmount}.`,
      ...(suggestedValue > 0 ? [`The board said ${suggestedValue}; the room says ${amount}. Now who says ${nextAmount}?`] : []),
      ...(phase === "once" ? [`Once at ${amount}, but there is still daylight for ${nextAmount}.`] : []),
      ...(phase === "twice" ? [`Final pressure at ${amount}. ${nextAmount} keeps ${player.name} alive!`] : [])
    ],
    once: (amount) => [`${amount} dollars... going once.`, `At ${amount}, and the room is quiet. Going once.`, `${amount} is the number. Going once!`],
    twice: (amount) => [`Going twice at ${amount}. Last chance!`, `${amount} dollars, going twice. Fair warning!`, `Going twice! If you want in at ${amount}, this is the moment.`],
    sold: ({ player, team, amount }) => [`Sold! ${player.name} to ${team.name}, managed by ${team.manager}, for ${amount} dollars!`, `And that's a sale! ${team.manager} lands ${player.name} for ${amount} dollars.`, `The hammer falls! ${player.name} joins ${team.name} for ${amount}.`],
    passed: (player) => [`No takers. ${player.name} heads back to the player pool.`, `The room says not today. ${player.name} goes back into the pool.`, `No sale on ${player.name}. We'll see if the room regrets that later.`],
    simultaneous: ({ amount, managers }) => `Hold it! Simultaneous bids at ${amount} dollars from ${managers}. The auction is paused for a ruling.`,
    preflight: "Can you hear Lucy? Your Sun God auctioneer is ready."
  },
  hype: {
    nomination: (player) => [`Make some noise for ${player.name}! ${player.position}, ${player.nflTeam}. One dollar and we are LIVE!`, `${player.name} just hit the block! Who is brave enough to start it at one?`, `Here we go! ${player.name}, ${player.position}, ${player.nflTeam}. Open the bidding!`],
    phoneBid: ({ amount, manager, nextAmount }) => [`BOOM! ${manager} punches in ${amount}! Who brings ${nextAmount}?`, `${manager} attacks at ${amount}! I need ${nextAmount}!`, `Phone bid! ${amount} from ${manager}. Keep it moving to ${nextAmount}!`],
    bid: ({ amount, manager, nextAmount }) => [`${manager} storms in at ${amount}! Who has ${nextAmount}?`, `${amount} and the room is heating up! Give me ${nextAmount}!`, `${manager} owns it at ${amount}! Not for long—who has ${nextAmount}?`],
    openingPatter: (player) => [
      `${player.name} is loose on the block! One dollar, one decision—who makes the first move?`,
      `¡Atención, draft room! ${player.name} is waiting and one dollar takes command!`,
      `Here comes the pressure! ${player.position}, ${player.nflTeam}, and nobody has struck first!`,
      `Do not look away! ${player.name} can be yours, but somebody has to attack!`,
      `One dollar starts the action! Who wants the ball, who wants the player, who wants the moment?`
    ],
    patter: ({ player, amount, manager, nextAmount, phase, suggestedValue }) => [
      `${manager} has ${player.name} at ${amount}, but the counterattack is waiting! ${nextAmount} takes the lead!`,
      `From one side of the room to the other—${amount} is the score, ${nextAmount} changes the game!`,
      `${player.name}, ${manager}, ${amount}—the pressure is rising, rising, RISING!`,
      `The room surges forward and pulls back! ${amount} stands, ${nextAmount} breaks it open!`,
      `What a moment on the block! ${manager} in front, ${player.name} in play, ${nextAmount} to steal it!`,
      `¡Vamos! We are at ${amount}, we need ${nextAmount}, and somebody has to make the move!`,
      ...(suggestedValue > 0 ? [`The board said ${suggestedValue}, the room has ${amount}, and the drama wants ${nextAmount}!`] : []),
      ...(phase === "once" ? [`Once at ${amount}! The window is open, the lane is clear—${nextAmount} keeps it alive!`] : []),
      ...(phase === "twice" ? [`Last attack, final seconds! ${amount} leads, ${nextAmount} saves the auction!`] : [])
    ],
    once: (amount) => [`${amount} going once! Do not blink!`, `Going once at ${amount}! The clock is burning!`, `${amount} once! Somebody make a move!`],
    twice: (amount) => [`${amount} going twice! Final shot!`, `Going twice at ${amount}! This is it!`, `${amount} twice! Last call for glory!`],
    sold: ({ player, team, amount }) => [`SOLD! ${team.manager} takes home ${player.name} for ${amount}!`, `HAMMER DOWN! ${player.name} to ${team.name} for ${amount}!`, `What a finish! ${player.name}, ${amount} dollars, and ${team.manager} gets the win!`],
    passed: (player) => [`No sale! ${player.name} lives to fight another round.`, `Nobody jumped! ${player.name} heads back to the pool.`, `${player.name} escapes the block without a buyer!`],
    simultaneous: ({ amount, managers }) => `Stop the clock! ${managers} collide at ${amount}! We need a ruling!`,
    preflight: "Can you hear Lucy? Let's light up this draft room!"
  },
  pro: {
    nomination: (player) => [`${player.name}. ${player.position}, ${player.nflTeam}. Bidding opens at one.`, `Next nomination: ${player.name}. One dollar to start.`, `${player.name} is nominated. Bidding begins at one.`],
    phoneBid: ({ amount, manager, nextAmount }) => [`${manager}, ${amount}. Next is ${nextAmount}.`, `${amount} from ${manager}. Looking for ${nextAmount}.`, `${manager} leads at ${amount}. Next bid, ${nextAmount}.`],
    bid: ({ amount, manager, nextAmount }) => [`${manager} at ${amount}. Next is ${nextAmount}.`, `${amount}, ${manager}. Looking for ${nextAmount}.`, `${manager} leads at ${amount}.`],
    openingPatter: (player) => [
      `${player.name} remains open at one.`,
      `One dollar starts the market for ${player.name}.`,
      `No opening bid yet. ${player.name}, one dollar.`,
      `${player.position} is available. First bid takes control.`
    ],
    patter: ({ player, amount, manager, nextAmount, phase, suggestedValue }) => [
      `${manager} leads at ${amount}. Next bid, ${nextAmount}.`,
      `${player.name} at ${amount}. The room needs ${nextAmount}.`,
      `${amount} holds. ${nextAmount} changes the leader.`,
      `Current leader, ${manager}. Current price, ${amount}.`,
      ...(suggestedValue > 0 ? [`Suggested ${suggestedValue}; live price ${amount}; next ${nextAmount}.`] : []),
      ...(phase === "once" ? [`Once at ${amount}. ${nextAmount} remains available.`] : []),
      ...(phase === "twice" ? [`Final window. ${amount} leads; ${nextAmount} extends.`] : [])
    ],
    once: (amount) => [`${amount}. Going once.`, `Going once at ${amount}.`, `${amount}, once.`],
    twice: (amount) => [`${amount}. Going twice.`, `Going twice at ${amount}.`, `${amount}, twice. Final call.`],
    sold: ({ player, team, amount }) => [`Sold. ${player.name} to ${team.name} for ${amount}.`, `${team.manager} wins ${player.name} at ${amount}.`, `${player.name}, sold for ${amount} to ${team.name}.`],
    passed: (player) => [`No sale. ${player.name} returns to the pool.`, `${player.name} passes without a bid.`, `No bids for ${player.name}.`],
    simultaneous: ({ amount, managers }) => `Simultaneous bids at ${amount} from ${managers}. Auction paused for a ruling.`,
    preflight: "Can you hear Lucy? Audio check complete."
  }
};

export function createAuctioneerScript({ personality = "classic" } = {}) {
  const turns = new Map();
  const profile = LINES[personality] || LINES.classic;
  const choose = (key, choices) => {
    const index = turns.get(key) || 0;
    turns.set(key, index + 1);
    return choices[index % choices.length];
  };

  return {
    nomination(player) { return choose("nomination", profile.nomination(player)); },
    bid(values) { return choose(`bid-${values.source || "manual"}`, (values.source === "phone" ? profile.phoneBid : profile.bid)(values)); },
    patter(values) { return choose(values.manager ? "patter-active" : "patter-opening", values.manager ? profile.patter(values) : profile.openingPatter(values.player)); },
    goingOnce(amount) { return choose("once", profile.once(amount)); },
    goingTwice(amount) { return choose("twice", profile.twice(amount)); },
    sold(values) { return choose("sold", profile.sold(values)); },
    passed(player) { return choose("passed", profile.passed(player)); },
    simultaneous(values) { return profile.simultaneous(values); },
    preflight() { return profile.preflight; }
  };
}
