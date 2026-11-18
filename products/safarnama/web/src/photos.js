/**
 * Destination photos for the quick planner: one well-known sight per place, from Wikimedia Commons.
 * Bundled from assets/destinations (800×600 WebP), so they load wherever Safarnama runs. Each is used under its licence; the credit is shown on the tile.
 * Generated once by a build script; edit by hand if a photo is replaced.
 */
const FILES = import.meta.glob('./assets/destinations/*.webp', { eager: true, import: 'default' })
const url = (file) => FILES[`./assets/destinations/${file}`]

const SOURCES = {
  "Goa": {
    "src": "goa.webp",
    "landmark": "Palolem Beach",
    "author": "iMahesh",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Palolem_Beach,_South_Goa.jpg"
  },
  "Jaipur": {
    "src": "jaipur.webp",
    "landmark": "Hawa Mahal",
    "author": "Chainwit.",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:East_facade_Hawa_Mahal_Jaipur_from_ground_level_(July_2022)_-_img_01.jpg"
  },
  "Udaipur": {
    "src": "udaipur.webp",
    "landmark": "Lake Pichola",
    "author": "Uri Sittan Tripo",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Udaipur_Lake_India.JPG"
  },
  "Varanasi": {
    "src": "varanasi.webp",
    "landmark": "The ghats",
    "author": "Ken Wieland",
    "license": "CC BY-SA 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Ahilya_Ghat_by_the_Ganges,_Varanasi.jpg"
  },
  "Rishikesh": {
    "src": "rishikesh.webp",
    "landmark": "Lakshman Jhula",
    "author": "KaustubhNayyar",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Rishikesh-Lakshman_Jhula_by_Kaustubh_Nayyar.jpg"
  },
  "Munnar": {
    "src": "munnar.webp",
    "landmark": "Tea hills",
    "author": "Kondephy",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Munnar_Overview.jpg"
  },
  "Alappuzha": {
    "src": "alappuzha.webp",
    "landmark": "Houseboats",
    "author": "Augustus Binu",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:House_Boat_DSW.jpg"
  },
  "Hampi": {
    "src": "hampi.webp",
    "landmark": "Virupaksha Temple",
    "author": "iMahesh",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Complex_of_Virupaksha_Temple,_Hampi_(04).jpg"
  },
  "Puducherry": {
    "src": "puducherry.webp",
    "landmark": "Rock Beach",
    "author": "Karthik Easvur",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Pondicherry-Rock_beach_aerial_view.jpg"
  },
  "Leh": {
    "src": "leh.webp",
    "landmark": "Thiksey Monastery",
    "author": "Aksveer",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Thikse_Monastery_.jpg"
  },
  "Darjeeling": {
    "src": "darjeeling.webp",
    "landmark": "The toy train",
    "author": "Arne Hückelheim",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:DarjeelingTrainFruitshop_(2).jpg"
  },
  "Kodagu": {
    "src": "kodagu.webp",
    "landmark": "Abbey Falls",
    "author": "Santhoshkumar Sugumar",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Abbey_Falls_New.jpg"
  },
  "Kyoto": {
    "src": "kyoto.webp",
    "landmark": "Fushimi Inari",
    "author": "Basile Morin",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Torii_path_with_lantern_at_Fushimi_Inari_Taisha_Shrine,_Kyoto,_Japan.jpg"
  },
  "Lisbon": {
    "src": "lisbon.webp",
    "landmark": "Belém Tower",
    "author": "Alvesgaspar",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Torre_Bel%C3%A9m_April_2009-4a.jpg"
  },
  "Bali": {
    "src": "bali.webp",
    "landmark": "Ulun Danu Bratan",
    "author": "LukeTriton",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Pura_Ulun_Danu_Bratan,_2022.jpg"
  },
  "Singapore": {
    "src": "singapore.webp",
    "landmark": "Gardens by the Bay",
    "author": "Shiny Things.",
    "license": "CC BY 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Supertree_Grove,_Gardens_by_the_Bay,_Singapore_-_20120712-02.jpg"
  },
  "Istanbul": {
    "src": "istanbul.webp",
    "landmark": "Hagia Sophia",
    "author": "Adli Wahid",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Hagia_Sophia_(228968325).jpeg"
  },
  "Kathmandu": {
    "src": "kathmandu.webp",
    "landmark": "Boudhanath",
    "author": "Sumitbhatt222",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Boudhanath_stupa_,_Kathmandu,_Nepal.jpg"
  }
}

export const PHOTOS = Object.fromEntries(Object.entries(SOURCES).map(([name, p]) => [name, { ...p, src: url(p.src) }]))
