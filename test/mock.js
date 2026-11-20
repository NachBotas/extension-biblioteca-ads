// Genera anuncios con la misma forma que devuelve el GraphQL de la Biblioteca de anuncios.
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const CDN = 'https://video.xx.fbcdn.net/test';
const IMG = 'https://scontent.xx.fbcdn.net/test';

const templates = [
  { page: 'Ramiro Cubria', cta_type: 'VIEW_INSTAGRAM_PROFILE', cta_text: 'Ir al perfil de Instagram', link: 'https://www.instagram.com/ramirocubria', caption: 'WWW.INSTAGRAM.COM', body: 'Comentá 10 👇 y te mando la guía gratis', fmt: 'VIDEO' },
  { page: 'Ramiro Cubria', cta_type: 'VIEW_INSTAGRAM_PROFILE', cta_text: 'Ir al perfil de Instagram', link: 'https://www.instagram.com/ramirocubria', caption: 'WWW.INSTAGRAM.COM', body: 'Comentá CEBOLLA y te paso el método', fmt: 'VIDEO' },
  { page: 'Academia Trading Pro', cta_type: 'WHATSAPP_MESSAGE', cta_text: 'Enviar mensaje de WhatsApp', link: 'https://api.whatsapp.com/send?phone=5491100000000', caption: 'WHATSAPP', body: '¿Querés aprender a operar desde cero? Escribinos por WhatsApp y te asesoramos sin costo.\n\nCupos limitados.\n\nInscripciones abiertas hasta el viernes.', fmt: 'VIDEO' },
  { page: 'Inmobiliaria Norte', cta_type: 'MESSAGE_PAGE', cta_text: 'Enviar mensaje', link: 'https://m.me/inmobiliarianorte', caption: 'MESSENGER', body: 'Departamentos de 2 ambientes desde USD 85.000. Consultanos por mensaje.', fmt: 'IMAGE' },
  { page: 'Curso Copywriting', cta_type: 'LEARN_MORE', cta_text: 'Más información', link: 'https://pay.hotmart.com/curso-copy', caption: 'PAY.HOTMART.COM', body: 'El curso que te enseña a escribir anuncios que venden.', fmt: 'VIDEO' },
  { page: 'Tienda Zapatillas', cta_type: 'SHOP_NOW', cta_text: 'Comprar', link: 'https://tiendazapas.com/oferta', caption: 'TIENDAZAPAS.COM', body: '3x2 en toda la tienda 🔥 Solo por esta semana.', fmt: 'CAROUSEL' },
  { page: 'Dr. Martínez Odontología', cta_type: 'CALL_NOW', cta_text: 'Llamar', link: 'tel:+541140000000', caption: '', body: 'Turnos de urgencia las 24 hs. Llamanos ahora.', fmt: 'IMAGE' },
  { page: 'Coach Fitness Lu', cta_type: 'INSTAGRAM_MESSAGE', cta_text: 'Enviar mensaje', link: 'https://ig.me/m/coachlu', caption: 'INSTAGRAM', body: 'Mandame "PLAN" por DM y te paso la rutina.', fmt: 'VIDEO' },
  { page: 'Agencia Growth', cta_type: 'SIGN_UP', cta_text: 'Registrarte', link: 'https://agenciagrowth.io/webinar', caption: 'AGENCIAGROWTH.IO', body: 'Webinar gratuito: cómo escalar tus campañas a 6 cifras.', fmt: 'VIDEO' },
  { page: 'Marca Personal Sofi', cta_type: 'NO_BUTTON', cta_text: '', link: '', caption: '', body: 'Nuevo episodio del podcast disponible 🎙️', fmt: 'IMAGE' },
  { page: 'App Finanzas', cta_type: 'INSTALL_MOBILE_APP', cta_text: 'Instalar ahora', link: 'https://play.google.com/store/apps/details?id=com.finanzas', caption: 'PLAY.GOOGLE.COM', body: 'Controlá tus gastos en 1 minuto por día.', fmt: 'IMAGE' },
  { page: 'Pizzería Don Pepe', cta_type: 'LIKE_PAGE', cta_text: 'Me gusta la página', link: 'https://www.facebook.com/donpepe', caption: '', body: 'Seguinos para enterarte de las promos.', fmt: 'IMAGE' },
];

let seq = 0;
function makeAd(i, opts = {}) {
  const t = templates[i % templates.length];
  const id = String(1684862343252026 + i * 7919 + (opts.offset || 0));
  const startDaysAgo = [5, 45, 12, 90, 3, 31, 150, 8, 62, 1, 20, 400][i % 12] + (opts.offset ? 2 : 0);
  const active = i % 9 !== 4;
  const img = `${IMG}/img${(i % 6) + 1}.jpg`;
  const snapshot = {
    page_name: t.page,
    page_id: String(100000 + (i % templates.length)),
    page_profile_uri: `https://www.facebook.com/page${i % templates.length}`,
    page_profile_picture_url: `${IMG}/avatar.jpg`,
    body: { text: t.body },
    title: t.page,
    caption: t.caption,
    cta_type: t.cta_type,
    cta_text: t.cta_text,
    link_url: t.link,
    display_format: t.fmt,
    videos: [],
    images: [],
    cards: [],
  };
  if (t.fmt === 'VIDEO') snapshot.videos = [{ video_hd_url: `${CDN}/video.mp4?hd=${id}`, video_sd_url: `${CDN}/video.mp4?sd=${id}`, video_preview_image_url: img }];
  else if (t.fmt === 'CAROUSEL') snapshot.cards = [1, 2, 3].map((k) => ({ original_image_url: `${IMG}/img${k}.jpg?c=${id}`, resized_image_url: `${IMG}/img${k}.jpg?c=${id}`, cta_type: t.cta_type, cta_text: t.cta_text, link_url: t.link, title: `Modelo ${k}` }));
  else snapshot.images = [{ original_image_url: img + `?i=${id}`, resized_image_url: img + `?i=${id}` }];
  seq++;
  return {
    ad_archive_id: id,
    collation_count: [1, 3, 1, 7, 1, 2][i % 6],
    collation_id: 'c' + id,
    start_date: now - startDaysAgo * DAY,
    end_date: active ? now + DAY : now - 2 * DAY,
    is_active: active,
    page_id: snapshot.page_id,
    page_name: t.page,
    publisher_platform: i % 3 === 0 ? ['FACEBOOK', 'INSTAGRAM', 'MESSENGER'] : i % 3 === 1 ? ['INSTAGRAM'] : ['FACEBOOK', 'INSTAGRAM'],
    snapshot,
  };
}

function page(ads, cursor, hasNext, count) {
  return {
    data: {
      ad_library_main: {
        search_results_connection: {
          count,
          page_info: { end_cursor: cursor, has_next_page: hasNext },
          edges: ads.map((a) => ({ node: { collated_results: [a] } })),
        },
      },
    },
  };
}

module.exports = { makeAd, page, templates };
