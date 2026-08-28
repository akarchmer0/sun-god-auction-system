import { parseCsv } from "./draft-io.mjs";

const FANTASY_PROS_VALUES = `
Jahmyr Gibbs|63
Puka Nacua|60
Bijan Robinson|57
Ja'Marr Chase|57
Jaxon Smith-Njigba|55
Amon-Ra St. Brown|52
Christian McCaffrey|50
Jonathan Taylor|48
Derrick Henry|41
De'Von Achane|39
Drake London|38
James Cook III|37
CeeDee Lamb|37
Justin Jefferson|36
Chase Brown|35
Rashee Rice|35
Saquon Barkley|34
Trey McBride|34
Chris Olave|33
Josh Allen|32
Kenneth Walker III|32
A.J. Brown|32
Ashton Jeanty|31
George Pickens|31
Brock Bowers|31
Omarion Hampton|30
Jeremiyah Love|30
Nico Collins|30
Josh Jacobs|29
Kyren Williams|28
Breece Hall|28
Zay Flowers|28
Malik Nabers|27
Javonte Williams|26
Travis Etienne Jr.|25
Cam Skattebo|25
Garrett Wilson|25
Tetairoa McMillan|24
DeVonta Smith|24
Emeka Egbuka|24
D'Andre Swift|23
Davante Adams|22
Tee Higgins|22
Quinshon Judkins|21
Bucky Irving|21
Jameson Williams|21
Colston Loveland|21
Bhayshul Tuten|19
Ladd McConkey|19
Terry McLaurin|17
Rome Odunze|17
DJ Moore|17
Jaylen Waddle|16
Luther Burden III|16
Tyler Warren|16
Lamar Jackson|15
David Montgomery|15
Mike Evans|15
Harold Fannin Jr.|15
Jayden Daniels|14
Jadarian Price|14
Jalen Hurts|13
Drake Maye|13
TreVeyon Henderson|13
Rhamondre Stevenson|13
Jaylen Warren|13
Tony Pollard|13
Marvin Harrison Jr.|13
Christian Watson|13
Courtland Sutton|13
Alec Pierce|13
J.K. Dobbins|12
DK Metcalf|12
George Kittle|12
Rico Dowdle|11
Kyle Pitts Sr.|11
Sam LaPorta|11
Joe Burrow|10
Chuba Hubbard|10
Dallas Goedert|10
Tucker Kraft|10
Travis Kelce|10
Jaxson Dart|9
Brock Purdy|8
Trevor Lawrence|8
Dak Prescott|8
Jonathon Brooks|8
Kenny Gainwell|8
Parker Washington|8
Brian Thomas Jr.|8
Patrick Mahomes II|7
Kyle Monangai|7
Rachaad White|7
Jacory Croskey-Merritt|7
Aaron Jones Sr.|7
RJ Harvey|7
Jordan Mason|7
Michael Pittman Jr.|7
Caleb Williams|6
Justin Herbert|6
Blake Corum|6
Carnell Tate|6
Jakobi Meyers|6
Michael Wilson|6
Jayden Reed|6
Mark Andrews|6
Bo Nix|5
Quentin Johnston|5
Chris Godwin Jr.|5
Jordan Addison|5
Xavier Worthy|5
Isaiah Likely|5
Dalton Kincaid|5
Matthew Stafford|4
Tyjae Spears|4
Isiah Pacheco|4
Zach Charbonnet|4
Woody Marks|4
Wan'Dale Robinson|4
KC Concepcion|4
Jake Ferguson|4
Jared Goff|3
Alvin Kamara|3
Romeo Doubs|3
Deebo Samuel Sr.|3
De'Zhaun Stribling|3
Stefon Diggs|3
Hunter Henry|3
Tyler Shough|2
MarShawn Lloyd|2
Justice Hill|2
Chris Rodriguez Jr.|2
Dylan Sampson|2
Mike Washington Jr.|2
AJ Dillon|2
Tyler Allgeier|2
Braelon Allen|2
Matthew Golden|2
Rashid Shaheed|2
Khalil Shakir|2
Josh Downs|2
Juwan Johnson|2
Brenton Strange|2
Houston Texans|2
Denver Broncos|2
Minnesota Vikings|2
Pittsburgh Steelers|2
Baker Mayfield|1
Kyler Murray|1
Samaje Perine|1
Kaelon Black|1
Tyrone Tracy Jr.|1
Jalen Coker|1
Denzel Boston|1
Jerry Jeudy|1
Calvin Ridley|1
Makai Lemon|1
Dalton Schultz|1
Seattle Seahawks|1
Los Angeles Chargers|1
Detroit Lions|1
Los Angeles Rams|1
Buffalo Bills|1
Atlanta Falcons|1
Philadelphia Eagles|1
Baltimore Ravens|1
Brandon Aubrey|1
Jason Myers|1
Ka'imi Fairbairn|1
Cameron Dicker|1
Harrison Mevis|1
Jake Bates|1
Blake Grupe|1
Cairo Santos|1
Chase McLaughlin|1
Eddy Pineiro|1
Tyler Loop|1
Harrison Butker|1
Cam Little|0
Will Reichard|0
Evan McPherson|0
Wil Lutz|0
Cleveland Browns|0
Chicago Bears|0
New Orleans Saints|0
Jacksonville Jaguars|0
Cincinnati Bengals|0
New England Patriots|0
Tampa Bay Buccaneers|0
Tennessee Titans|0
Green Bay Packers|0
Indianapolis Colts|0
Washington Commanders|0
Kansas City Chiefs|0
Dallas Cowboys|0
Ty Johnson|0
Brian Robinson Jr.|0
Tank Bigsby|0
Daniel Jones|0
Jordan Love|0
Malik Willis|0
Trey Smack|0
Tyler Bass|0
Nick Folk|0
Jake Elliott|0
Daniel Carlson|0
Andy Borregales|0
Chris Boswell|0
Tre Tucker|0
Rashod Bateman|0
T.J. Hockenson|0
Pat Freiermuth|0
Greg Dulcich|0
New York Giants|0
Miami Dolphins|0
Arizona Cardinals|0
Las Vegas Raiders|0
San Francisco 49ers|0
Carolina Panthers|0
New York Jets|0
Keaton Mitchell|0
Emari Demercado|0
Jordan James|0
Najee Harris|0
Sam Darnold|0
C.J. Stroud|0
Drew Stevens|0
Riley Patterson|0
Joey Slye|0
Jason Sanders|0
Keenan Allen|0
Chad Ryland|0
Jalen McMillan|0
Jauan Jennings|0
Ja'Kobi Lane|0
Terrance Ferguson|0
Cade Otton|0
Kenyon Sadiq|0
AJ Barner|0
Chig Okonkwo|0
Jonah Coleman|0
Adam Randall|0
Bryce Young|0
Jalen Nailor|0
Devaughn Vele|0
Kayshon Boutte|0
Cooper Kupp|0
Darren Waller|0
Malik Davis|0
James Conner|0
Kimani Vidal|0
Jaydon Blue|0
Tank Dell|0
Adonai Mitchell|0
Travis Hunter|0
Evan Engram|0
Gunnar Helm|0
David Njoku|0
Mike Gesicki|0
Emanuel Wilson|0
Jaylen Wright|0
Jawhar Jordan|0
Kyle Juszczyk|0
Malik Washington|0
Germie Bernard|0
Dontayvion Wicks|0
Jordyn Tyson|0
Bub Means|0
Antonio Williams|0
Jaylin Noel|0
Caleb Douglas|0
Omar Cooper Jr.|0
Oronde Gadsden II|0
Mason Taylor|0
Isaiah Davis|0
George Holani|0
Chris Brooks|0
LeQuint Allen Jr.|0
Jerome Ford|0
Frank Gore Jr.|0
Roschon Johnson|0
Ollie Gordon II|0
Emmett Johnson|0
Trayveon Williams|0
Ray Davis|0
DJ Giddens|0
Sean Tucker|0
Austin Ekeler|0
Geno Smith|0
Cam Ward|0
Jacoby Brissett|0
Tory Horton|0
Darius Slayton|0
Troy Franklin|0
Chris Bell|0
Tyquan Thornton|0
Xavier Legette|0
Colby Parkinson|0
Brashard Smith|0
Elijah Mitchell|0
Aaron Rodgers|0
Jahan Dotson|0
Tre' Harris|0
Isaac TeSlaa|0
Ryan Flournoy|0
Michael Mayer|0
Christian Kirk|0
Ted Hurst III|0
Dawson Knox|0
Hollywood Brown|0
Jalen Tolbert|0
Malik Benson|0
Elic Ayomanor|0
Xavier Hutchinson|0
DeMario Douglas|0
Andrei Iosivas|0
Chimere Dike|0
Zachariah Branch|0
Keon Coleman|0
Theo Johnson|0
Darnell Washington|0
Jonnu Smith|0
Tyler Higbee|0
Darnell Mooney|0
Pat Bryant|0
Joshua Palmer|0
Ashton Dulin|0
Malachi Fields|0
Marvin Mims Jr.|0
KaVontae Turpin|0
Cole Kmet|0
Erick All Jr.|0
Zavion Thomas|0
Devontez Walker|0
Jack Bech|0
Fernando Mendoza|0
Deshaun Watson|0
Tua Tagovailoa|0
Michael Penix Jr.|0
Shedeur Sanders|0
`;

const QUARTERBACKS = new Set(`
Josh Allen
Drake Maye
Lamar Jackson
Jayden Daniels
Jalen Hurts
Jaxson Dart
Joe Burrow
Brock Purdy
Dak Prescott
Trevor Lawrence
Patrick Mahomes II
Justin Herbert
Caleb Williams
Bo Nix
Matthew Stafford
Jared Goff
Tyler Shough
Baker Mayfield
Kyler Murray
Daniel Jones
Malik Willis
Jordan Love
Sam Darnold
C.J. Stroud
Bryce Young
Geno Smith
Jacoby Brissett
Cam Ward
Aaron Rodgers
Fernando Mendoza
Tua Tagovailoa
Deshaun Watson
Shedeur Sanders
Michael Penix Jr.
`.trim().split("\n"));

const RUNNING_BACKS = new Set(`
Jahmyr Gibbs
Bijan Robinson
Jonathan Taylor
Christian McCaffrey
Derrick Henry
James Cook III
De'Von Achane
Saquon Barkley
Josh Jacobs
Ashton Jeanty
Chase Brown
Omarion Hampton
Kyren Williams
Breece Hall
Kenneth Walker III
Javonte Williams
Jeremiyah Love
Cam Skattebo
Travis Etienne Jr.
D'Andre Swift
Bucky Irving
Quinshon Judkins
Bhayshul Tuten
TreVeyon Henderson
David Montgomery
Jadarian Price
Tony Pollard
Rico Dowdle
J.K. Dobbins
Chuba Hubbard
Jaylen Warren
Rhamondre Stevenson
Kyle Monangai
Jacory Croskey-Merritt
RJ Harvey
Rachaad White
Aaron Jones Sr.
Blake Corum
Jordan Mason
Kenny Gainwell
Jonathon Brooks
Zach Charbonnet
Woody Marks
Isiah Pacheco
Tyrone Tracy Jr.
Tyjae Spears
Chris Rodriguez Jr.
Alvin Kamara
Brian Robinson Jr.
Justice Hill
Tyler Allgeier
Braelon Allen
AJ Dillon
Samaje Perine
Jordan James
Dylan Sampson
Ty Johnson
Kaelon Black
Emari Demercado
Tank Bigsby
Mike Washington Jr.
Keaton Mitchell
Malik Davis
Adam Randall
Chris Brooks
Kimani Vidal
James Conner
Emanuel Wilson
Jaylen Wright
Jawhar Jordan
Jaydon Blue
Kendre Miller
MarShawn Lloyd
George Holani
Frank Gore Jr.
Roschon Johnson
Kyle Juszczyk
Ollie Gordon II
Sean Tucker
Emmett Johnson
Ray Davis
Isaiah Davis
Jonah Coleman
DJ Giddens
Austin Ekeler
Ty Chandler
Najee Harris
LeQuint Allen Jr.
Jerome Ford
Trayveon Williams
Brashard Smith
Elijah Mitchell
`.trim().split("\n"));

const TIGHT_ENDS = new Set(`
Brock Bowers
Trey McBride
Colston Loveland
Tyler Warren
Kyle Pitts Sr.
Dallas Goedert
Sam LaPorta
Tucker Kraft
Harold Fannin Jr.
Travis Kelce
George Kittle
Mark Andrews
Dalton Kincaid
Isaiah Likely
Hunter Henry
Jake Ferguson
Brenton Strange
Juwan Johnson
Dalton Schultz
Pat Freiermuth
Kenyon Sadiq
Greg Dulcich
T.J. Hockenson
Oronde Gadsden II
Terrance Ferguson
AJ Barner
Cade Otton
Chig Okonkwo
Mike Gesicki
Evan Engram
Gunnar Helm
David Njoku
Colby Parkinson
Mason Taylor
Dawson Knox
Michael Mayer
Darren Waller
Theo Johnson
Darnell Washington
Jonnu Smith
Tyler Higbee
Cole Kmet
Erick All Jr.
`.trim().split("\n"));

const KICKERS = new Set(`
Brandon Aubrey
Jason Myers
Ka'imi Fairbairn
Cameron Dicker
Harrison Mevis
Jake Bates
Chase McLaughlin
Cairo Santos
Eddy Pineiro
Tyler Loop
Harrison Butker
Will Reichard
Cam Little
Evan McPherson
Nick Folk
Wil Lutz
Trey Smack
Tyler Bass
Charlie Smyth
Jake Moody
Andy Borregales
Jake Elliott
Chris Boswell
Jason Sanders
Zane Gonzalez
Joey Slye
Chad Ryland
Blake Grupe
Daniel Carlson
Drew Stevens
Riley Patterson
`.trim().split("\n"));

const DEFENSES = new Set(`
Houston Texans
Denver Broncos
Pittsburgh Steelers
Minnesota Vikings
Seattle Seahawks
Detroit Lions
Buffalo Bills
Los Angeles Rams
Los Angeles Chargers
Atlanta Falcons
Philadelphia Eagles
Chicago Bears
Baltimore Ravens
Cleveland Browns
New Orleans Saints
Cincinnati Bengals
Jacksonville Jaguars
New England Patriots
Tampa Bay Buccaneers
Tennessee Titans
Green Bay Packers
Washington Commanders
Indianapolis Colts
Kansas City Chiefs
New York Giants
Dallas Cowboys
Las Vegas Raiders
Arizona Cardinals
Miami Dolphins
San Francisco 49ers
Carolina Panthers
New York Jets
`.trim().split("\n"));

function positionFor(name) {
  if (QUARTERBACKS.has(name)) return "QB";
  if (RUNNING_BACKS.has(name)) return "RB";
  if (TIGHT_ENDS.has(name)) return "TE";
  if (KICKERS.has(name)) return "K";
  if (DEFENSES.has(name)) return "DST";
  return "WR";
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function basePlayer(name, value, index) {
  return {
    id: `fantasy-pros-${slug(name)}-${index}`,
    name,
    position: positionFor(name),
    nflTeam: "FA",
    suggestedValue: Number(value),
    status: "available"
  };
}

export function fantasyProsPlayersFromCsv(csvText) {
  const parsed = parseCsv(csvText);
  const headers = parsed.headers.map((header) => String(header || "").trim().toLowerCase());
  const playerIndex = headers.indexOf("player");
  const valueIndex = headers.indexOf("value");
  if (playerIndex < 0 || valueIndex < 0) throw new Error("data/player_values.csv must contain player and value columns.");
  const seen = new Set();
  return parsed.rows.map((row, index) => {
    const name = String(row[playerIndex] || "").trim();
    const value = Number(row[valueIndex]);
    const key = slug(name);
    if (!name) throw new Error(`data/player_values.csv row ${index + 2} has no player name.`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`data/player_values.csv row ${index + 2} has an invalid value.`);
    if (seen.has(key)) throw new Error(`data/player_values.csv contains a duplicate player: ${name}.`);
    seen.add(key);
    return basePlayer(name, Math.round(value), index);
  });
}

export const fantasyProsPlayers = FANTASY_PROS_VALUES.trim().split("\n").map((line, index) => {
  const [name, value] = line.split("|");
  return basePlayer(name, value, index);
});
