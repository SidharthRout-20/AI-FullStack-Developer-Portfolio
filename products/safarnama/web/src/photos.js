/**
 * Destination photos for the quick planner: one well-known sight per place, from Wikimedia Commons.
 * Bundled from assets/destinations (800×600 WebP), so they load wherever Safarnaama runs. Each is used under its licence; the credit is shown on the tile.
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
  },
  "Manali": {
    "src": "manali.webp",
    "landmark": "Rohtang Pass",
    "author": "Vyacheslav Argenberg",
    "license": "CC BY 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Kullu_Valley_from_Rohtang_Pass,_India.jpg"
  },
  "Shimla": {
    "src": "shimla.webp",
    "landmark": "Christ Church",
    "author": "ShashankSharma2511",
    "license": "CC BY 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Christ_Church,_Shimla.jpg"
  },
  "Dharamshala": {
    "src": "dharamshala.webp",
    "landmark": "Namgyal Monastery",
    "author": "(in search for a new country of residence), on Flickr",
    "license": "CC BY-SA 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Namgyal_Monastery_India_Himachal_Pradesh_Mc_Leod_Ganj.jpg"
  },
  "Srinagar": {
    "src": "srinagar.webp",
    "landmark": "Dal Lake",
    "author": "Suhail Skindar Sofi",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Dal_Lake_Hazratbal_Srinagar.jpg"
  },
  "Amritsar": {
    "src": "amritsar.webp",
    "landmark": "Golden Temple",
    "author": "Shagil Kannur",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:The_Golden_Temple_of_Amrithsar_7.jpg"
  },
  "Agra": {
    "src": "agra.webp",
    "landmark": "Taj Mahal",
    "author": "Yann; edited by Jim Carter",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Taj_Mahal_(Edited).jpeg"
  },
  "Jodhpur": {
    "src": "jodhpur.webp",
    "landmark": "Mehrangarh Fort",
    "author": "Sanhitasinha",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Mehrangarh_Fort_sanhita.jpg"
  },
  "Jaisalmer": {
    "src": "jaisalmer.webp",
    "landmark": "Jaisalmer Fort",
    "author": "Gérard Janot",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Jaisalmer_forteresse.jpg"
  },
  "Mahabaleshwar": {
    "src": "mahabaleshwar.webp",
    "landmark": "The Western Ghats",
    "author": "Amitban77",
    "license": "CC BY 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:MAHABALESWAR_LANDSCAPE.jpg"
  },
  "Khajuraho": {
    "src": "khajuraho.webp",
    "landmark": "Kandariya Mahadeva Temple",
    "author": "PLBechly",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:1_Khajuraho.jpg"
  },
  "Bodh Gaya": {
    "src": "bodh-gaya.webp",
    "landmark": "Mahabodhi Temple",
    "author": "Bpilgrim",
    "license": "CC BY-SA 2.5",
    "source": "https://commons.wikimedia.org/wiki/File:Mahabodhitemple.jpg"
  },
  "Kolkata": {
    "src": "kolkata.webp",
    "landmark": "Victoria Memorial",
    "author": "Subhrajyoti07",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Victoria_Memorial_situated_in_Kolkata.jpg"
  },
  "Gangtok": {
    "src": "gangtok.webp",
    "landmark": "Tsomgo Lake",
    "author": "Indrajit Das",
    "license": "CC BY 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Tsongmo_Lake_or_Changu_Lake_-_East_Sikkim.jpg"
  },
  "Shillong": {
    "src": "shillong.webp",
    "landmark": "A living root bridge",
    "author": "Arshiya Urveeja Bose",
    "license": "CC BY 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Living_root_bridges,_Nongriat_village,_Meghalaya2.jpg"
  },
  "Port Blair": {
    "src": "port-blair.webp",
    "landmark": "Radhanagar Beach",
    "author": "Harvinder Chandigarh",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Radha_Nagar_beach,_Havelock_Island,_Andamn,_India-_Sun_set_view.jpg"
  },
  "Hyderabad": {
    "src": "hyderabad.webp",
    "landmark": "Charminar",
    "author": "DidierTais",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Charminar_Hyderabad_1.jpg"
  },
  "Ooty": {
    "src": "ooty.webp",
    "landmark": "Nilgiri Mountain Railway",
    "author": "A.M. Hurrell",
    "license": "CC BY 2.5",
    "source": "https://commons.wikimedia.org/wiki/File:NMR_train_at_Ketti_05-02-26_75.jpeg"
  },
  "Wayanad": {
    "src": "wayanad.webp",
    "landmark": "Chembra Peak",
    "author": "Aneesh Jose",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Chembra.jpg"
  },
  "Madurai": {
    "src": "madurai.webp",
    "landmark": "Meenakshi Temple",
    "author": "எஸ்ஸார்",
    "license": "CC BY 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:An_aerial_view_of_Madurai_city_from_atop_of_Meenakshi_Amman_temple.jpg"
  },
  "Nainital": {
    "src": "nainital.webp",
    "landmark": "Naini Lake",
    "author": "Incorelabs",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:The_Boat_and_The_Lake.jpg"
  },
  "Dubai": {
    "src": "dubai.webp",
    "landmark": "Burj Khalifa",
    "author": "imran shahabuddin",
    "license": "CC BY 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Burj_Khalifa_(worlds_tallest_building)_and_the_Dubai_skyline_(25781049892).jpg"
  },
  "Bangkok": {
    "src": "bangkok.webp",
    "landmark": "Wat Arun",
    "author": "Mastertongapollo",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:%E0%B9%80%E0%B8%88%E0%B8%94%E0%B8%B5%E0%B8%A2%E0%B9%8C%E0%B8%9B%E0%B8%A3%E0%B8%B0%E0%B8%98%E0%B8%B2%E0%B8%99%E0%B8%97%E0%B8%A3%E0%B8%87%E0%B8%9B%E0%B8%A3%E0%B8%B2%E0%B8%87%E0%B8%84%E0%B9%8C%E0%B8%A7%E0%B8%B1%E0%B8%94%E0%B8%AD%E0%B8%A3%E0%B8%B8%E0%B8%932.jpg"
  },
  "Phuket": {
    "src": "phuket.webp",
    "landmark": "Phi Phi Islands",
    "author": "Luxure",
    "license": "CC BY 3.0 au",
    "source": "https://commons.wikimedia.org/wiki/File:KohPhiPhi.JPG"
  },
  "Paro": {
    "src": "paro.webp",
    "landmark": "Tiger's Nest",
    "author": "Nina R (derivative work: UnpetitproleX)",
    "license": "CC BY 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Paro_Taktsang,_Bhutan_(edited).jpg"
  },
  "Pokhara": {
    "src": "pokhara.webp",
    "landmark": "Phewa Lake",
    "author": "Jmhullot",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Phewa_lake,_Pokhara.jpg"
  },
  "Hanoi": {
    "src": "hanoi.webp",
    "landmark": "Hoàn Kiếm Lake",
    "author": "Cyril Doussin from London, United Kingdom",
    "license": "CC BY-SA 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Thap_Rua.jpg"
  },
  "Hoi An": {
    "src": "hoi-an.webp",
    "landmark": "Japanese Covered Bridge",
    "author": "Chainwit.",
    "license": "CC BY 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:2024_H%E1%BB%99i_An_-_Japanese_Covered_Bridge_(Ch%C3%B9a_C%E1%BA%A7u)_after_renovation_-_img_11.jpg"
  },
  "Tokyo": {
    "src": "tokyo.webp",
    "landmark": "Sensō-ji",
    "author": "Akonnchiroll",
    "license": "CC0",
    "source": "https://commons.wikimedia.org/wiki/File:Sensoji_2023.jpg"
  },
  "Baku": {
    "src": "baku.webp",
    "landmark": "Maiden Tower",
    "author": "AlixSaz",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Maiden_tower_IMG_8521.jpg"
  },
  "Tbilisi": {
    "src": "tbilisi.webp",
    "landmark": "Narikala Fortress",
    "author": "Alexxx1979",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Tbilisi_IMG_8846_1920.jpg"
  },
  "Almaty": {
    "src": "almaty.webp",
    "landmark": "Big Almaty Lake",
    "author": "МаратД",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Big_Almaty_Lake_(2511_m)_and_snowy_peak_of_Soviets_(4317_m)_in_September,_2,_2017.jpg"
  },
  "Paris": {
    "src": "paris.webp",
    "landmark": "Eiffel Tower",
    "author": "Benh LIEU SONG",
    "license": "Public domain",
    "source": "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons_(cropped).jpg"
  },
  "London": {
    "src": "london.webp",
    "landmark": "Tower Bridge",
    "author": "Fuzzypiggy",
    "license": "CC BY-SA 3.0",
    "source": "https://commons.wikimedia.org/wiki/File:Tower_Bridge_at_Dawn.jpg"
  },
  "Interlaken": {
    "src": "interlaken.webp",
    "landmark": "Lake Brienz",
    "author": "Carsten Steger",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Aerial_image_of_Lake_Brienz_(view_from_the_southwest).jpg"
  },
  "Rome": {
    "src": "rome.webp",
    "landmark": "Colosseum",
    "author": "FeaturedPics",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Colosseo_2020.jpg"
  },
  "Barcelona": {
    "src": "barcelona.webp",
    "landmark": "Sagrada Família",
    "author": "Canaan",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:SF_maig_2_cropped.jpg"
  },
  "Amsterdam": {
    "src": "amsterdam.webp",
    "landmark": "The canal ring",
    "author": "Andrés Barrios",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Imagen_de_los_canales_conc%C3%A9ntricos_en_%C3%81msterdam.png"
  },
  "Cape Town": {
    "src": "cape-town.webp",
    "landmark": "Table Mountain",
    "author": "Danie van der Merwe from Cape Town, South Africa",
    "license": "CC BY 2.0",
    "source": "https://commons.wikimedia.org/wiki/File:Table_Mountain_DanieVDM.jpg"
  },
  "Sydney": {
    "src": "sydney.webp",
    "landmark": "Sydney Opera House",
    "author": "BAVhah",
    "license": "CC BY-SA 4.0",
    "source": "https://commons.wikimedia.org/wiki/File:Sydney_Opera_House_2026.jpg"
  }
}

export const PHOTOS = Object.fromEntries(Object.entries(SOURCES).map(([name, p]) => [name, { ...p, src: url(p.src) }]))
