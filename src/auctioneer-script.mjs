export const AUCTIONEER_PERSONALITIES = Object.freeze({
  classic: { name: "Lucy Classic", description: "Warm, witty, and in control." },
  hype: { name: "Hype House", description: "Big reactions and draft-night drama." },
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
    goingOnce(amount) { return choose("once", profile.once(amount)); },
    goingTwice(amount) { return choose("twice", profile.twice(amount)); },
    sold(values) { return choose("sold", profile.sold(values)); },
    passed(player) { return choose("passed", profile.passed(player)); },
    simultaneous(values) { return profile.simultaneous(values); },
    preflight() { return profile.preflight; }
  };
}
