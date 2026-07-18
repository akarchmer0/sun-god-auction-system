export function createAuctioneerScript() {
  const turns = new Map();
  const choose = (key, choices) => {
    const index = turns.get(key) || 0;
    turns.set(key, index + 1);
    return choices[index % choices.length];
  };

  return {
    nomination(player) {
      return choose("nomination", [
        `Next on the block: ${player.name}, ${player.position}, ${player.nflTeam}. We open at one dollar. Who wants in?`,
        `${player.name} is up! ${player.position} for ${player.nflTeam}. One dollar gets us started. Let's see those bids.`,
        `All eyes up front. It's ${player.name}, ${player.position}, ${player.nflTeam}. Opening at one. Who's first?`
      ]);
    },
    bid({ amount, manager, nextAmount, source = "manual" }) {
      const lines = source === "phone" ? [
        `${manager} fires in at ${amount}! Now give me ${nextAmount}.`,
        `${amount} from ${manager}! Looking for ${nextAmount}.`,
        `${manager} takes it to ${amount}! Who has ${nextAmount}?`
      ] : [
        `${amount} dollars with ${manager}. Do I hear ${nextAmount}?`,
        `${manager} has it at ${amount}. Looking for ${nextAmount}.`,
        `${amount} to ${manager}! Who moves it to ${nextAmount}?`
      ];
      return choose(`bid-${source}`, lines);
    },
    goingOnce(amount) {
      return choose("once", [
        `${amount} dollars... going once.`,
        `At ${amount}, and the room is quiet. Going once.`,
        `${amount} is the number. Going once!`
      ]);
    },
    goingTwice(amount) {
      return choose("twice", [
        `Going twice at ${amount}. Last chance!`,
        `${amount} dollars, going twice. Fair warning!`,
        `Going twice! If you want in at ${amount}, this is the moment.`
      ]);
    },
    sold({ player, team, amount }) {
      return choose("sold", [
        `Sold! ${player.name} to ${team.name}, managed by ${team.manager}, for ${amount} dollars!`,
        `And that's a sale! ${team.manager} lands ${player.name} for ${amount} dollars.`,
        `The hammer falls! ${player.name} joins ${team.name} for ${amount}.`
      ]);
    },
    passed(player) {
      return choose("passed", [
        `No takers. ${player.name} heads back to the player pool.`,
        `The room says not today. ${player.name} goes back into the pool.`,
        `No sale on ${player.name}. We'll see if the room regrets that later.`
      ]);
    },
    simultaneous({ amount, managers }) {
      return `Hold it! Simultaneous bids at ${amount} dollars from ${managers}. The auction is paused for a ruling.`;
    }
  };
}
