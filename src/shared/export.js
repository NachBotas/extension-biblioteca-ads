/*
 * Exportación a Excel (.xlsx real, sin librerías) y CSV.
 * El .xlsx se arma a mano: un ZIP sin compresión con el XML mínimo de una planilla.
 */
(function (g) {
  const BAP = g.BAP || (g.BAP = {});

  // ---------- ZIP (método "store", sin compresión) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, dosTime, true);
      cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);

      offset += 30 + name.length + data.length;
    }
    const cenSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // ---------- XLSX ----------
  const xmlEsc = (s) =>
    String(s == null ? '' : s)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function colName(i) {
    let s = '';
    i++;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  /**
   * columns: [{ header, width, type: 'text'|'number'|'date'|'link', get(row) , linkText?(row) }]
   */
  BAP.buildXlsx = function (rows, columns, sheetName = 'Anuncios') {
    const links = [];
    let sheetRows = '';
    // cabecera
    sheetRows += '<row r="1">';
    columns.forEach((c, ci) => {
      sheetRows += `<c r="${colName(ci)}1" t="inlineStr" s="1"><is><t>${xmlEsc(c.header)}</t></is></c>`;
    });
    sheetRows += '</row>';

    rows.forEach((row, ri) => {
      const r = ri + 2;
      sheetRows += `<row r="${r}">`;
      columns.forEach((c, ci) => {
        const ref = `${colName(ci)}${r}`;
        const v = c.get(row);
        if (v == null || v === '') return;
        if (c.type === 'number' && Number.isFinite(Number(v))) {
          sheetRows += `<c r="${ref}"><v>${Number(v)}</v></c>`;
        } else if (c.type === 'date') {
          const serial = Number(v) / 86400000 + 25569 - new Date(Number(v)).getTimezoneOffset() / 1440;
          sheetRows += `<c r="${ref}" s="2"><v>${serial.toFixed(5)}</v></c>`;
        } else if (c.type === 'link' && /^https?:\/\//i.test(String(v)) && String(v).length < 2000) {
          links.push({ ref, url: String(v) });
          const label = c.linkText ? c.linkText(row) : v;
          sheetRows += `<c r="${ref}" t="inlineStr" s="3"><is><t>${xmlEsc(label)}</t></is></c>`;
        } else {
          const text = String(v).slice(0, 32000);
          sheetRows += `<c r="${ref}" t="inlineStr"${c.wrap ? ' s="4"' : ''}><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
        }
      });
      sheetRows += '</row>';
    });

    const lastCol = colName(columns.length - 1);
    const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join('');
    const hyperlinks = links.length
      ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rIdL${i + 1}"/>`).join('')}</hyperlinks>`
      : '';

    const sheet =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${cols}</cols>` +
      `<sheetData>${sheetRows}</sheetData>` +
      `<autoFilter ref="A1:${lastCol}${Math.max(1, rows.length + 1)}"/>` +
      hyperlinks +
      '</worksheet>';

    const sheetRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      links
        .map(
          (l, i) =>
            `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(l.url)}" TargetMode="External"/>`
        )
        .join('') +
      '</Relationships>';

    const styles =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
      '<fonts count="3">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
      '<font><u/><sz val="11"/><color rgb="FF5B4FE9"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF6D5DF5"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="5">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="0" vertical="top"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    const files = [
      {
        name: '[Content_Types].xml',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'xl/workbook.xml',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${xmlEsc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
          `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(sheetName).slice(0, 31)}'!$A$1:$${lastCol}$${Math.max(1, rows.length + 1)}</definedName></definedNames>` +
          '</workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          '</Relationships>',
      },
      { name: 'xl/styles.xml', data: styles },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: sheetRels },
    ];
    return zip(files);
  };

  // ---------- CSV ----------
  BAP.buildCsv = function (rows, columns) {
    const q = (v) => {
      const s = v == null ? '' : String(v);
      return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.map((c) => q(c.header)).join(',')];
    for (const row of rows) {
      lines.push(
        columns
          .map((c) => {
            const v = c.get(row);
            if (c.type === 'date') return q(BAP.isoDate(v));
            return q(v);
          })
          .join(',')
      );
    }
    return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  };

  // ---------- Columnas de anuncios ----------
  const destLabel = (a) => (BAP.destByKey[a.dest] || {}).label || a.dest;
  const firstVideo = (a) => (a.media || []).find((m) => m.type === 'video');
  const firstImage = (a) => (a.media || []).find((m) => m.type === 'image');

  BAP.adColumns = function (opts = {}) {
    const cols = [
      { header: 'Link del anuncio', width: 18, type: 'link', get: (a) => a.url, linkText: () => 'Ver anuncio' },
      { header: 'ID biblioteca', width: 20, type: 'text', get: (a) => a.id },
      { header: 'Anunciante', width: 26, type: 'text', get: (a) => a.pageName },
      { header: 'Página', width: 14, type: 'link', get: (a) => a.pageUrl, linkText: () => 'Abrir página' },
      { header: 'Estado', width: 10, type: 'text', get: (a) => (a.isActive ? 'Activo' : 'Inactivo') },
      { header: 'Días activo', width: 12, type: 'number', get: (a) => a.days },
      { header: 'Inicio', width: 12, type: 'date', get: (a) => a.start },
      { header: 'Fin', width: 12, type: 'date', get: (a) => (a.isActive ? null : a.end) },
      { header: 'Destino', width: 16, type: 'text', get: destLabel },
      { header: 'Canal', width: 18, type: 'text', get: (a) => a.channel },
      { header: 'Botón (CTA)', width: 20, type: 'text', get: (a) => a.ctaText },
      { header: 'Tipo de CTA', width: 20, type: 'text', get: (a) => a.ctaType },
      { header: 'URL de destino', width: 40, type: 'link', get: (a) => a.linkUrl },
      { header: 'Formato', width: 11, type: 'text', get: (a) => ({ video: 'Video', image: 'Imagen', carousel: 'Carrusel', text: 'Texto' })[a.mediaType] || a.mediaType },
      { header: 'Plataformas', width: 26, type: 'text', get: (a) => (a.platforms || []).map((p) => BAP.PLATFORM_LABELS[p] || p).join(', ') },
      { header: 'Versiones', width: 10, type: 'number', get: (a) => a.copies },
      { header: 'Alcance UE', width: 12, type: 'number', get: (a) => a.reach },
      { header: 'Título', width: 30, type: 'text', get: (a) => a.title },
      { header: 'Texto del anuncio', width: 60, type: 'text', wrap: true, get: (a) => a.body },
      { header: 'Video (link temporal)', width: 18, type: 'link', get: (a) => (firstVideo(a) || {}).hd || (firstVideo(a) || {}).sd, linkText: () => 'Video' },
      { header: 'Imagen (link temporal)', width: 18, type: 'link', get: (a) => (firstImage(a) || {}).url || (firstVideo(a) || {}).poster, linkText: () => 'Imagen' },
    ];
    if (opts.saved) {
      cols.splice(2, 0, { header: 'Carpeta', width: 16, type: 'text', get: (a) => a.folder });
      cols.push({ header: 'Nota', width: 40, type: 'text', get: (a) => a.note });
      cols.push({ header: 'Guardado el', width: 14, type: 'date', get: (a) => a.savedAt });
    }
    return cols;
  };

  BAP.downloadBlob = function (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 4000);
  };

  BAP.exportAds = function (ads, format, opts = {}) {
    const cols = BAP.adColumns(opts);
    const stamp = BAP.isoDate(Date.now());
    const base = `${opts.prefix || 'anuncios'}_${stamp}`;
    if (format === 'csv') BAP.downloadBlob(BAP.buildCsv(ads, cols), `${base}.csv`);
    else BAP.downloadBlob(BAP.buildXlsx(ads, cols), `${base}.xlsx`);
  };
})(typeof window !== 'undefined' ? window : self);
