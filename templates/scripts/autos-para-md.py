#!/usr/bin/env python3
"""
Autos em PDF → Markdown ancorado em folha, para a memória do squad.

Por que existe: `indexar-autos.mjs` inventaria a pasta e extrai texto cru com
`pdftotext`. Isso serve ao índice, mas deixa o agente relendo o PDF a cada step
— caro e lento num processo de 700 páginas — e simplesmente NÃO VÊ as páginas
sem camada de texto (num caso real: 73 de 707). Este script converte uma vez e
grava Markdown que o agente lê, grepa e cita.

Honesto por construção — a regra do motor vale aqui:
- Cada página vira um bloco ancorado (`<!-- fls. N/M -->`), para a peça poder
  citar folha. Sem âncora, o agente cita de memória.
- Página sem texto passa por OCR e sai **marcada como OCR**, nunca misturada ao
  texto nativo: texto reconhecido por máquina é hipótese, e citar folha a partir
  dele sem conferir é o mesmo erro de citar jurisprudência de memória.
- Página em que o OCR não acha texto sai como `imagem` (há uma figura a olhar:
  foto, nota, documento escaneado ilegível) ou `vazia` (nada a ler), com a
  imagem ao lado — nunca se inventa conteúdo, e o agente pode abrir a imagem.
  Sem OCR disponível a folha sem camada de texto sai `vazia`: ninguém a leu.
- O manifesto registra a procedência de CADA página. O que o script não
  conseguiu ler, ele diz que não conseguiu.
- FIGURAS: a foto dentro de uma folha com texto (laudo com fotos e legendas,
  petição com prints) não muda a classificação da folha, que continua `nativo`
  ou `ocr`, e antes nunca era vista. Toda figura embutida acima do tamanho
  mínimo (ver `eh_figura`; a foto desenhada pequena na folha também entra
  quando tem legenda de foto ou resolução própria de foto) sai recortada em `imagens/figura-NNNN-K.jpg`, com a
  legenda próxima, e entra no manifesto (`figuras`) e no Markdown da folha como
  bloco marcado, que o `sumario-autos.mjs integrar` preenche com a descrição.
  OCR que leu textura de foto (`parece_ruido`) não faz da folha uma folha de
  texto: ela sai `imagem`.
- FOTO DENTRO DE FOLHA ESCANEADA: a folha digitalizada é uma imagem só, e a foto colada nela não é
  figura embutida. `regioes_de_foto` acha a foto pela distribuição de tons em blocos (texto e papel são
  quase binários; foto tem tons médios e textura), tira os blocos cobertos por palavra lida com
  confiança e recorta o retângulo que passa no mesmo piso das figuras, com a legenda lida por OCR logo
  abaixo ou acima. Entra em `figuras` com `origem: "regiao_escaneada"` (as outras, `embutida`).
- PASSADA DE FIGURAS (`--figuras`): sobre autos JÁ convertidos, só as figuras (embutidas e de folha
  escaneada), o manifesto e os blocos do documento.md; sem OCR de folha, sem mudar o texto das folhas.
- IMAGENS AVULSAS (fotos juntadas à pasta, JPG/PNG/HEIC): inventariadas em
  `_md/_imagens-avulsas.json` com data e hora da captura e dispositivo do EXIF;
  o GPS só como `presente`/`ausente`, nunca o valor. HEIC, TIFF e BMP ganham
  uma cópia JPG para a leitura visual.

Dependências (fora do Node, por isso um script à parte):
    pip install pymupdf4llm pytesseract Pillow      # + tesseract no PATH

Uso:
    python3 scripts/autos-para-md.py squads/<nome>            # todos os PDFs de autos/
    python3 scripts/autos-para-md.py squads/<nome> --sem-ocr  # pula o OCR
    python3 scripts/autos-para-md.py squads/<nome> --figuras  # só as figuras, autos já convertidos
    python3 scripts/autos-para-md.py <arquivo.pdf> --saida <dir>
"""
import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

MIN_TEXTO = 40          # menos que isto numa página = sem camada de texto útil
# Rodapé e carimbo que o PJe (e outros sistemas) imprimem em TODA folha como texto nativo:
# "Este documento foi gerado pelo usuário ... Número do documento ... https://pje... Assinado
# eletronicamente por ... Num. N - Pág. M". Numa folha que é só foto, nota fiscal ou boletim
# escaneado, esse rodapé sozinho passa de 300 caracteres e a folha era classificada como
# `nativo`: sem OCR, sem imagem, e o conteúdo real sumia. Medido num caso de 506 folhas:
# 36 folhas de fotos, notas e BO ficaram invisíveis assim. A decisão de camada de texto é
# feita sobre o texto ÚTIL, com o rodapé e o lixo de "picture text" descontados.
# Tolerante ao OCR: o rodapé reconhecido por máquina vem com "hitps://pje.cloud.tipe" e
# "Pág 1" sem ponto, e ainda assim é rodapé.
# Cada regra é limitada pelo próprio conteúdo (a frase do rodapé até a data, o token da URL, o
# "Num. N - Pág. M"), nunca por "até o fim da linha": o extrator junta as linhas do rodapé numa
# só, e às vezes com a linha seguinte, e o `.*$` da assinatura apagava o dispositivo da sentença.
# Sem fronteira de palavra, `esaj` casava dentro de "desajuste" e `eproc` dentro de
# "reprocessamento". O rodapé nunca é apagado do texto gravado: só da MEDIÇÃO (texto útil),
# que decide a camada de texto da folha.
_ATE_A_DATA = r'[^\n]{0,120}?(?:\d{2}/\d{2}/\d{4}[ \d:]*|$)'
RE_RODAPE = re.compile(
    r'este documento foi gerado' + _ATE_A_DATA +
    r'|n[uú]mero do documento:?(?:[ \t]*\d{8,})?'
    r'|assinado (?:eletronicamente|digitalmente) por' + _ATE_A_DATA +
    r'|documento assinado digitalmente' + _ATE_A_DATA +
    r'|este documento [eé] c[oó]pia do original' + _ATE_A_DATA +
    r'|(?:https?|hitps?|htps?)[ \t]*:[ \t]*/[ \t]*/[ \t]*\S+'
    r'|\S*(?:\.jus\.br|listview\.seam)\S*'
    r'|\b(?:pje|esaj|projudi|eproc)\.(?:[a-z0-9-]+\.)+[a-z]{2,}\S*'
    r'|num\.?[ \t]*\d{4,}[ \t]*-?[ \t]*p[aá]g\.?[ \t]*\d+'
    r'|^[^\w\n]{0,4}(?:fls?\.?[ \t]*\d+|\d{15,})[ \t]*$',
    re.IGNORECASE | re.MULTILINE)
# OCR curto numa folha dominada por figura (legenda, data, carimbo) não faz dela folha de
# texto: sai como `imagem`, com o que o OCR leu mantido como pista.
TEXTO_CURTO = 300
RE_PICTURE_TEXT = re.compile(r'<!-- Start of picture text -->.*?<!-- End of picture text -->', re.DOTALL)
# Área mínima de imagem (fração da página) para uma folha sem texto útil e sem OCR legível
# sair como `imagem` (página de figura, a descrever) em vez de `vazia` (nada a ler).
AREA_IMAGEM = 0.30
# Acima disto a "figura" é a página inteira rasterizada (folha digitalizada): não diz nada sobre
# o conteúdo, e um despacho escaneado curto é texto, não imagem.
PAGINA_INTEIRA = 0.90
OCR_DPI = 200           # densidade do render antes do OCR
# A imagem existe para o profissional CONFERIR o que o OCR leu, não para
# arquivar fac-símile. Em PNG a 220 dpi, as 73 folhas escaneadas de um processo
# real pesaram 151 MB — mais do que o PDF inteiro, dentro da pasta do squad, que
# é copiada e versionada. JPEG a 200 dpi lê igual e cabe em ~1/10.
IMG_QUALIDADE = 82
BLOCO = 25              # folhas por chamada ao extrator — progresso visível e memória limitada
IDIOMA_OCR = 'por'      # autos brasileiros

# Figura embutida: o tamanho mínimo foi medido num PDF integral do PJe de 561 folhas (30/09/2026),
# com 1841 imagens embutidas. 1089 delas eram 91 imagens repetidas em 3 ou mais folhas (timbre,
# brasão, logotipo de cabeçalho); das únicas, a maior parte ficava abaixo de 4% da folha e 200 px
# no menor lado (assinatura, carimbo, selo, ícone). Entre 4% e 6% da folha ficam fotos pequenas em
# grade (uma foto de 6 x 4,5 cm numa A4 cobre 4,3%): subir o piso para 6% cortava 29 das 60 figuras
# que o filtro achou naquele PDF (51 delas em folhas `nativo`, antes invisíveis; 49 com legenda).
FIG_FRACAO_MIN = 0.04   # fração da área da folha
FIG_PX_MIN = 200        # pixels no menor lado da imagem original
# Foto desenhada pequena na folha. Medido no teste de ponta a ponta de 30/09/2026: a "Fotografia 2"
# de um relatório de vistoria (960 x 720 px) estava desenhada em 72 x 54 pt no pé da folha, 0,8% da
# área, e o piso de 4% a jogou fora junto com logotipos e carimbos; era a foto do gesso caindo, que
# sustentava o perigo da tutela. O tamanho na folha não diz se é foto; a resolução própria e a
# legenda dizem. Abaixo de 4% da folha, entra a imagem com legenda de foto ("Fotografia 2", "Foto 3",
# "Figura 1") e pelo menos FIG_PX_MIN no menor lado, ou a imagem única (sem repetição) com resolução
# de foto: FIG_PX_FOTO no menor lado, FIG_PIXELS_FOTO no total e proporção de foto (até 2:1, o que
# deixa de fora a assinatura escaneada em alta resolução). Logotipo e carimbo continuam fora: têm
# baixa resolução ou se repetem pelas folhas.
FIG_FRACAO_MIN_MINIATURA = 0.002   # abaixo disto nem miniatura: ícone, marca d'água, ponto
FIG_PX_FOTO = 480
FIG_PIXELS_FOTO = 300_000
FIG_PROPORCAO_FOTO = 2.0
RE_LEGENDA_DE_FOTO = re.compile(r'(?<![a-z])(fotografia|foto|figura|fig\.|imagem)\s*(n[º°o.]?\s*)?\d+', re.I)
FIG_PROPORCAO_MAX = 4.0  # faixa de cabeçalho ou rodapé (banner) passa disto; foto e print, não
FIG_REPETIDA = 3        # a mesma imagem (digest) em 3 ou mais folhas é timbre, não prova
# Acima disto, uma imagem que contém o texto da folha (ou numa folha sem texto) é a própria folha
# digitalizada: medido no mesmo PDF, 104 imagens grandes em folhas sem camada de texto e 2 em
# folhas de PDF pesquisável (texto por cima da digitalização). A folha digitalizada segue pela
# classificação (`ocr`, `imagem`), não como figura.
FIG_RASTER = 0.60
# Na folha `imagem` (o OCR não leu texto), a imagem grande é foto, não scan, até esta fração: no
# mesmo PDF, as fotos de folha inteira cobriam de 52% a 67% da folha e o scan de baixa resolução, 87%.
FIG_RASTER_FOLHA_DE_IMAGEM = 0.80
FIG_DPI = 200           # densidade do recorte, limitada pela resolução original da imagem
FIG_LADO_MAX = 1600     # a leitura visual reduz acima disto; gravar maior só pesa na pasta
FIG_LADO_RECORTE_MIN = 1000  # lado maior mínimo do recorte quando a imagem original tem mais
LEGENDA_ABAIXO = 60     # pontos entre a figura e a legenda abaixo dela
LEGENDA_ACIMA = 40      # pontos entre o título acima e a figura
LEGENDA_MAX = 300       # caracteres da legenda no manifesto
# OCR de foto lê textura como letra: "ii 1! ;: Wi". Menos que esta fração de palavras reconhecíveis
# no texto útil é ruído, e a folha é de imagem. Texto de despacho digitalizado passa de 0,8.
RUIDO_PALAVRAS = 0.5
RUIDO_MIN_TOKENS = 12
EXT_AVULSA = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp', '.heic', '.heif')
EXT_LEGIVEL = ('.jpg', '.jpeg', '.png', '.webp', '.gif')   # o que a leitura visual abre direto
AVULSAS_JSON = '_imagens-avulsas.json'
AVULSAS_DIR = '_imagens-avulsas'


def sair(msg, codigo=1):
    print(f'autos-para-md: {msg}', file=sys.stderr)
    raise SystemExit(codigo)


def slug(nome):
    """Mesma regra de `slugDeArquivo` em `indexar-autos.mjs`: caminho relativo a `autos/`, sem a
    extensão, sem acento, não-alfanumérico vira hífen. As duas cópias precisam concordar, ou o
    índice aponta para uma pasta que não existe (`anexos/apolice.pdf` → `anexos-apolice`)."""
    base = unicodedata.normalize('NFD', str(Path(nome).with_suffix('')))
    base = ''.join(c for c in base if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-zA-Z0-9]+', '-', base).strip('-').lower()[:80]


# Rodapé do PJe na folha: `Num. 12345678 - Pág. 3`. O cabeçalho da folha no Markdown leva os dois
# números (`## fls. 57 · Num. 12345678 - Pág. 3`), para a peça citar como o tribunal cita.
RE_NUM_PJE = re.compile(r'\bnum\.?[ \t]*(\d{5,})[ \t]*-?[ \t]*p[aá]g\.?[ \t]*(\d{1,4})\b', re.IGNORECASE)
RE_NUM_PJE_LINHA = re.compile(r'^[ \t]*num\.?[ \t]*(\d{5,})[ \t]*-?[ \t]*p[aá]g\.?[ \t]*(\d{1,4})[ \t]*$',
                              re.IGNORECASE | re.MULTILINE)


def rodape_pje(texto):
    """`(num, pag)` do rodapé do PJe na folha, ou None: o rodapé sozinho na linha, senão a última menção
    (a mesma regra de `rodapeDaPagina` em `src/autos-pje.js`)."""
    achados = RE_NUM_PJE_LINHA.findall(texto or '') or RE_NUM_PJE.findall(texto or '')
    return achados[-1] if achados else None


def texto_util(texto):
    """O que sobra da camada de texto depois do rodapé de sistema e do lixo de figura."""
    t = RE_PICTURE_TEXT.sub('', texto or '')
    t = RE_RODAPE.sub('', t)
    return re.sub(r'\s+', ' ', t).strip()


def fracao_de_imagem(pagina):
    """Fração da área da página coberta por imagens (0 quando não há)."""
    try:
        area = float(pagina.rect.width * pagina.rect.height) or 1.0
        coberta = 0.0
        for info in pagina.get_image_info():
            x0, y0, x1, y1 = info.get('bbox', (0, 0, 0, 0))
            coberta += max(0.0, x1 - x0) * max(0.0, y1 - y0)
        return min(1.0, coberta / area)
    except Exception:                                            # noqa: BLE001
        return 0.0


# Número conta como palavra quando tem cara de valor, data ou folha (dois dígitos ou separador entre
# dígitos): o "1", o "1%" e o "11," soltos são o que o OCR mais produz na textura de uma foto.
RE_PALAVRA = re.compile(r'^[(\["\'«]?(?:[A-Za-zÀ-ÖØ-öø-ÿ]{2,}(?:-[A-Za-zÀ-ÖØ-öø-ÿ]+)*|R\$|\d+(?:[.,/:-]\d+)+[%ºª]?|\d{2,}[%ºª]?)[)\]"\'».,;:!?]*$')
RE_VOGAL = re.compile(r'[aeiouyáéíóúâêôãõàAEIOUYÁÉÍÓÚÂÊÔÃÕÀ\d]')


def parece_ruido(texto):
    """
    O OCR leu textura de foto como letra? Fração de palavras reconhecíveis (letras com vogal, ou
    número) no texto útil abaixo de RUIDO_PALAVRAS. Texto curto demais para medir não é ruído: a
    classificação por tamanho já o trata.
    """
    tokens = texto_util(texto).split()
    if len(tokens) < RUIDO_MIN_TOKENS:
        return False
    boas = sum(1 for t in tokens if RE_PALAVRA.match(t) and RE_VOGAL.search(t))
    return boas / len(tokens) < RUIDO_PALAVRAS


def legenda_de_foto(legenda):
    """A legenda numera uma foto ("Fotografia 2.", "Foto 3:", "Figura 1 -", "Imagem 4")?"""
    return bool(legenda) and bool(RE_LEGENDA_DE_FOTO.search(legenda))


def eh_figura(*, fracao, largura, altura, proporcao, repeticoes, raster, legenda=None):
    """
    Uma imagem embutida é figura a descrever (foto, print, planta, gráfico) ou grafismo da folha?

    `fracao`: área da imagem na folha. `largura`/`altura`: pixels da imagem original.
    `proporcao`: lado maior sobre lado menor, na folha. `repeticoes`: em quantas folhas a mesma
    imagem aparece. `raster`: a imagem é a folha digitalizada (grande, e o texto da folha, se há,
    está dentro dela). `legenda`: o texto logo abaixo ou acima, quando há.
    """
    if raster or fracao >= PAGINA_INTEIRA:
        return False
    if proporcao > FIG_PROPORCAO_MAX or repeticoes >= FIG_REPETIDA:
        return False
    menor = min(largura, altura)
    if fracao >= FIG_FRACAO_MIN and menor >= FIG_PX_MIN:
        return True
    # Foto desenhada pequena na folha (ver FIG_PX_FOTO): a legenda ou a resolução própria decidem.
    if fracao < FIG_FRACAO_MIN_MINIATURA:
        return False
    if legenda_de_foto(legenda) and menor >= FIG_PX_MIN:
        return True
    return (repeticoes <= 1 and menor >= FIG_PX_FOTO and largura * altura >= FIG_PIXELS_FOTO
            and proporcao <= FIG_PROPORCAO_FOTO)


def exif_util(imagem):
    """
    Os metadados que servem à prova: data e hora da captura e o dispositivo. O GPS sai só como
    `presente` ou `ausente`: a coordenada identifica um lugar (muitas vezes a casa de alguém) e
    não entra no manifesto, que é copiado com a pasta do caso. Sem EXIF, None.
    """
    try:
        ex = imagem.getexif()
    except Exception:                                            # noqa: BLE001
        return None
    if not ex:
        return None
    try:
        sub = ex.get_ifd(0x8769)
    except Exception:                                            # noqa: BLE001
        sub = {}
    try:
        gps = bool(ex.get_ifd(0x8825))
    except Exception:                                            # noqa: BLE001
        gps = 0x8825 in ex

    def texto(v):
        if isinstance(v, bytes):
            v = v.decode('utf-8', 'ignore')
        return str(v).replace('\x00', '').strip() if v is not None else ''

    data = texto(sub.get(0x9003) or sub.get(0x9004) or ex.get(0x0132))
    fuso = texto(sub.get(0x9011) or sub.get(0x9010))
    marca, modelo = texto(ex.get(0x010F)), texto(ex.get(0x0110))
    out = {}
    m = re.match(r'^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})', data)
    if m:
        out['data_hora'] = f'{m[1]}-{m[2]}-{m[3]} {m[4]}:{m[5]}:{m[6]}' + (f' {fuso}' if fuso else '')
        out['data_hora_origem'] = 'EXIF da imagem (relógio do dispositivo, não conferido)'
    if marca or modelo:
        out['dispositivo'] = modelo if modelo.lower().startswith(marca.lower()) and marca else ' '.join(x for x in (marca, modelo) if x)
    if not out and not gps:
        return None
    out['gps'] = 'presente' if gps else 'ausente'
    return out


def legenda_proxima(blocos, bbox):
    """
    O texto logo abaixo da figura (ou, sem ele, logo acima), na mesma coluna: a legenda de um
    laudo ("Foto 3: vista do quadro de distribuição") ou o título de um print. Rodapé de sistema
    descontado; None quando não há texto perto.
    """
    x0, y0, x1, y1 = bbox
    melhor = None
    for b in blocos:
        if len(b) < 7 or b[6] != 0:
            continue
        bx0, by0, bx1, by1, texto = b[0], b[1], b[2], b[3], b[4]
        if min(x1, bx1) - max(x0, bx0) <= 0:
            continue
        util = texto_util(texto)
        if not util:
            continue
        abaixo, acima = by0 - y1, y0 - by1
        if -2 <= abaixo <= LEGENDA_ABAIXO:
            chave = (0, abaixo)
        elif -2 <= acima <= LEGENDA_ACIMA:
            chave = (1, acima)
        else:
            continue
        if melhor is None or chave < melhor[0]:
            melhor = (chave, util)
    if not melhor:
        return None
    util = melhor[1]
    return util if len(util) <= LEGENDA_MAX else util[:LEGENDA_MAX - 1].rstrip() + '…'


def repeticoes_por_digest(doc):
    """Em quantas folhas cada imagem (pelo digest do conteúdo) aparece."""
    folhas = {}
    for i in range(doc.page_count):
        try:
            infos = doc.load_page(i).get_image_info(hashes=True)
        except Exception:                                        # noqa: BLE001
            continue
        for info in infos:
            d = info.get('digest')
            if d:
                folhas.setdefault(d, set()).add(i)
    return {d: len(s) for d, s in folhas.items()}


def figuras_da_pagina(pagina, repeticoes, origem=None):
    """
    As figuras de uma folha, na ordem de leitura (de cima para baixo, da esquerda para a direita):
    `[{bbox, fracao, largura, altura, xref, legenda}]`, só as que passam por `eh_figura`. `origem`: a da
    folha na conversão, que diz se a imagem grande de uma folha sem texto é scan ou foto.
    """
    try:
        infos = pagina.get_image_info(hashes=True, xrefs=True)
    except Exception:                                            # noqa: BLE001
        return []
    area = float(pagina.rect.width * pagina.rect.height) or 1.0
    palavras = pagina.get_text('words')
    blocos = pagina.get_text('blocks')
    # Folha sem camada de texto útil (só o rodapé que o sistema carimbou fora do scan): se o OCR leu
    # texto nela (`ocr`), a imagem grande é a digitalização; se não leu (`imagem`), é uma foto. Pela
    # regra das palavras dentro, o rodapé fora do scan fazia dele uma "figura" quando ninguém tinha
    # posto texto na folha: na conversão o extrator põe, com o OCR dele, mas na passada de figuras,
    # sem OCR, 74 folhas digitalizadas de um caso real viravam figura.
    sem_texto_util = len(texto_util(pagina.get_text())) < MIN_TEXTO
    scan_minimo = FIG_RASTER_FOLHA_DE_IMAGEM if origem == 'imagem' else FIG_RASTER
    vistas, out = set(), []
    for info in infos:
        x0, y0, x1, y1 = info.get('bbox', (0, 0, 0, 0))
        # Recortada à folha: imagem que vaza a margem conta só o que aparece.
        x0, y0 = max(x0, pagina.rect.x0), max(y0, pagina.rect.y0)
        x1, y1 = min(x1, pagina.rect.x1), min(y1, pagina.rect.y1)
        w, h = x1 - x0, y1 - y0
        if w <= 0 or h <= 0:
            continue
        chave = (round(x0), round(y0), round(x1), round(y1))
        if chave in vistas:                  # a mesma imagem desenhada duas vezes no mesmo lugar
            continue
        vistas.add(chave)
        fracao = (w * h) / area
        raster = False
        if sem_texto_util and fracao >= scan_minimo:
            raster = True
        elif fracao >= FIG_RASTER:
            dentro = sum(1 for p in palavras if x0 <= (p[0] + p[2]) / 2 <= x1 and y0 <= (p[1] + p[3]) / 2 <= y1)
            raster = not palavras or dentro / len(palavras) > 0.5
        legenda = legenda_proxima(blocos, (x0, y0, x1, y1))
        if not eh_figura(fracao=fracao, largura=info.get('width', 0), altura=info.get('height', 0),
                         proporcao=max(w, h) / min(w, h), repeticoes=repeticoes.get(info.get('digest'), 1),
                         raster=raster, legenda=legenda):
            continue
        out.append({'bbox': (x0, y0, x1, y1), 'fracao': round(fracao, 4), 'largura': info.get('width', 0),
                    'altura': info.get('height', 0), 'xref': info.get('xref', 0),
                    'legenda': legenda})
    out.sort(key=lambda f: (round(f['bbox'][1] / 10), f['bbox'][0]))
    return out


def gravar_figura(doc, pagina, fig, destino_jpg, pymupdf):
    """Recorte da figura como aparece na folha, na resolução da imagem original (até FIG_DPI)."""
    x0, y0, x1, y1 = fig['bbox']
    polegadas = max((x1 - x0) / 72.0, (y1 - y0) / 72.0) or 1.0
    nativo = max(fig['largura'], fig['altura']) / polegadas
    dpi = max(72, min(FIG_DPI, int(nativo)))
    # Foto desenhada pequena (ver FIG_PX_FOTO): a 200 dpi o recorte de 72 pt sairia com 200 px, bem
    # menos que a imagem tem. Sobe até a resolução original, sem passar de FIG_LADO_RECORTE_MIN.
    if polegadas * dpi < FIG_LADO_RECORTE_MIN and nativo > dpi:
        dpi = int(min(nativo, FIG_LADO_RECORTE_MIN / polegadas))
    if max(x1 - x0, y1 - y0) / 72.0 * dpi > FIG_LADO_MAX:
        dpi = max(36, int(FIG_LADO_MAX / polegadas))
    pix = pagina.get_pixmap(clip=pymupdf.Rect(x0, y0, x1, y1), dpi=dpi)
    pix.pil_save(str(destino_jpg), format='JPEG', quality=IMG_QUALIDADE, optimize=True)
    exif = None
    if fig.get('xref'):
        try:
            bruto = doc.extract_image(fig['xref'])
            if bruto and bruto.get('ext') in ('jpeg', 'jpg'):
                import io
                from PIL import Image
                exif = exif_util(Image.open(io.BytesIO(bruto['image'])))
        except Exception:                                        # noqa: BLE001
            exif = None
    return pix.width, pix.height, exif


# --- Foto dentro de folha escaneada ---------------------------------------------------------------
# A folha digitalizada é UMA imagem de página: a foto colada nela (laudo escaneado com fotografias)
# não é figura embutida separada, `figuras_da_pagina` a descarta como `raster`, e o OCR a lia como
# texto. A detecção é pela distribuição de tons, em blocos: papel e texto são quase binários (muito
# papel, traço escuro); foto tem pouco papel, muitos tons médios e variação local. Blocos que o OCR
# (ou a camada de texto do PDF) cobre com palavra lida com confiança saem; os vizinhos de foto se
# juntam em retângulos, e só o retângulo cheio, de tons variados e acima do piso das figuras (4% da
# folha, 200 px) vira figura. Carimbo, assinatura e brasão são traço sobre papel (muito branco) e
# pequenos; mancha e sombra de digitalização são lisas (pouca textura, poucos tons) ou faixas.
REG_DPI = 72            # densidade da análise: 1 px = 1 ponto
REG_BLOCO = 12          # lado do bloco em pontos (4,2 mm): menor que a distância entre duas fotos
REG_ESCURO = 70         # abaixo disto o pixel é traço (tinta, texto)
REG_PAPEL_MARGEM = 30   # o papel vai do tom dominante claro menos isto até o branco
REG_BRANCO_MAX = 0.30   # bloco de foto tem no máximo esta fração de papel
REG_MEIO_MIN = 0.50     # e no mínimo esta de tons médios
REG_PREENCHIMENTO = 0.45  # blocos de foto sobre os blocos do retângulo (foto é retângulo cheio)
REG_TONS_MIN = 5        # faixas de tom (de 16) com ao menos 2% dos pixels da região
REG_TEXTURA_MIN = 4.0   # desvio-padrão médio dentro dos blocos da região (0 a 255)
REG_PALAVRA_CONF = 70   # confiança mínima do OCR para uma palavra tirar o bloco da foto
REG_PALAVRA_COBRE = 0.25  # fração do bloco coberta por palavra para ele ser texto
FIGURAS_VERSAO = 2      # 1: só embutidas (0.9.75); 2: embutidas e regiões de foto em folha escaneada


def _histograma_stats(h, papel_min):
    """(n, branco, escuro, medio, media, desvio) de um histograma de 256 tons."""
    n = sum(h) or 1
    branco = sum(h[papel_min:])
    escuro = sum(h[:REG_ESCURO])
    soma = sum(i * c for i, c in enumerate(h))
    media = soma / n
    var = sum(c * (i - media) ** 2 for i, c in enumerate(h)) / n
    return n, branco / n, escuro / n, (n - branco - escuro) / n, media, var ** 0.5


def nivel_do_papel(img):
    """O tom mínimo do papel: o tom claro dominante (a moda acima de 150) menos a margem."""
    h = img.histogram()
    moda = max(range(150, 256), key=lambda i: h[i])
    return max(150, moda - REG_PAPEL_MARGEM)


def grade_de_foto(img, bloco=REG_BLOCO):
    """
    `img` em tons de cinza (`L`), 1 px por ponto. Devolve `(grade, stats, papel)`: `grade[l][c]` é
    True no bloco com cara de foto; `stats[l][c]` = (histograma, desvio) para medir a região depois.
    """
    papel = nivel_do_papel(img)
    w, h = img.size
    linhas, colunas = max(1, h // bloco), max(1, w // bloco)
    grade = [[False] * colunas for _ in range(linhas)]
    stats = [[None] * colunas for _ in range(linhas)]
    for li in range(linhas):
        for co in range(colunas):
            hist = img.crop((co * bloco, li * bloco, (co + 1) * bloco, (li + 1) * bloco)).histogram()
            _, branco, _, medio, _, desvio = _histograma_stats(hist, papel)
            stats[li][co] = (hist, desvio)
            grade[li][co] = branco <= REG_BRANCO_MAX and medio >= REG_MEIO_MIN
    return grade, stats, papel


def _fechar(grade):
    """Fechamento 3x3 (dilata e erode): junta blocos de foto separados por um bloco claro."""
    L, C = len(grade), len(grade[0])

    def viz(g, li, co, fn):
        return fn(g[y][x] for y in range(max(0, li - 1), min(L, li + 2)) for x in range(max(0, co - 1), min(C, co + 2)))
    dil = [[viz(grade, li, co, any) for co in range(C)] for li in range(L)]
    return [[viz(dil, li, co, all) or grade[li][co] for co in range(C)] for li in range(L)]


def componentes(grade):
    """Retângulos (l0, c0, l1, c1), inclusivos, das regiões conexas (8 vizinhos) da grade fechada."""
    fechada = _fechar(grade)
    L, C = len(fechada), len(fechada[0])
    visto = [[False] * C for _ in range(L)]
    out = []
    for li in range(L):
        for co in range(C):
            if not fechada[li][co] or visto[li][co]:
                continue
            pilha, caixa = [(li, co)], [li, co, li, co]
            visto[li][co] = True
            while pilha:
                y, x = pilha.pop()
                caixa = [min(caixa[0], y), min(caixa[1], x), max(caixa[2], y), max(caixa[3], x)]
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < L and 0 <= nx < C and fechada[ny][nx] and not visto[ny][nx]:
                            visto[ny][nx] = True
                            pilha.append((ny, nx))
            out.append(tuple(caixa))
    return out


def separar_por_calhas(grade, caixa):
    """
    Fotos lado a lado com uma calha estreita entre elas (a grade de fotos de um laudo) o fechamento
    junta num retângulo só. Linha ou coluna inteira sem bloco de foto dentro do retângulo é calha: o
    retângulo se parte nela, e cada parte com foto segue sozinha.
    """
    l0, c0, l1, c1 = caixa
    for co in range(c0 + 1, c1):
        if not any(grade[li][co] for li in range(l0, l1 + 1)):
            return separar_por_calhas(grade, (l0, c0, l1, co - 1)) + separar_por_calhas(grade, (l0, co + 1, l1, c1))
    for li in range(l0 + 1, l1):
        if not any(grade[li][co] for co in range(c0, c1 + 1)):
            return separar_por_calhas(grade, (l0, c0, li - 1, c1)) + separar_por_calhas(grade, (li + 1, c0, l1, c1))
    # Sem calha: aparas das bordas vazias (a parte pode ter herdado linha ou coluna sem foto).
    while l0 < l1 and not any(grade[l0][co] for co in range(c0, c1 + 1)):
        l0 += 1
    while l1 > l0 and not any(grade[l1][co] for co in range(c0, c1 + 1)):
        l1 -= 1
    while c0 < c1 and not any(grade[li][c0] for li in range(l0, l1 + 1)):
        c0 += 1
    while c1 > c0 and not any(grade[li][c1] for li in range(l0, l1 + 1)):
        c1 -= 1
    return [(l0, c0, l1, c1)] if any(grade[li][co] for li in range(l0, l1 + 1) for co in range(c0, c1 + 1)) else []


def medir_regiao(grade, stats, caixa):
    """(preenchimento, faixas de tom, textura) de um retângulo da grade."""
    l0, c0, l1, c1 = caixa
    total = (l1 - l0 + 1) * (c1 - c0 + 1)
    foto = [(li, co) for li in range(l0, l1 + 1) for co in range(c0, c1 + 1) if grade[li][co]]
    if not foto:
        return 0.0, 0, 0.0
    hist = [0] * 16
    for li, co in foto:
        for i, c in enumerate(stats[li][co][0]):
            hist[i // 16] += c
    n = sum(hist) or 1
    tons = sum(1 for c in hist if c / n >= 0.02)
    textura = sum(stats[li][co][1] for li, co in foto) / len(foto)
    return len(foto) / total, tons, textura


def eh_regiao_de_foto(*, fracao, largura, altura, proporcao, preenchimento, tons, textura):
    """O retângulo de blocos de foto é fotografia (a descrever) ou mancha, sombra, carimbo, texto?"""
    if fracao >= PAGINA_INTEIRA or fracao < FIG_FRACAO_MIN or min(largura, altura) < FIG_PX_MIN:
        return False
    if proporcao > FIG_PROPORCAO_MAX:
        return False
    return preenchimento >= REG_PREENCHIMENTO and tons >= REG_TONS_MIN and textura >= REG_TEXTURA_MIN


def imagem_da_folha(pagina, palavras=None, exigir_texto=True):
    """
    A imagem que É a folha digitalizada (a mesma regra do `raster` de `figuras_da_pagina`): grande, e
    com o texto da folha, se há, dentro dela. `(bbox, largura, altura)` ou None. Na folha `ocr` (sem
    camada de texto útil) o texto nativo que houver é o rodapé que o sistema carimbou fora do scan, e
    não decide nada: `exigir_texto=False`.
    """
    try:
        infos = pagina.get_image_info()
    except Exception:                                            # noqa: BLE001
        return None
    area = float(pagina.rect.width * pagina.rect.height) or 1.0
    palavras = pagina.get_text('words') if palavras is None else palavras
    melhor = None
    for info in infos:
        x0, y0, x1, y1 = info.get('bbox', (0, 0, 0, 0))
        x0, y0 = max(x0, pagina.rect.x0), max(y0, pagina.rect.y0)
        x1, y1 = min(x1, pagina.rect.x1), min(y1, pagina.rect.y1)
        if x1 <= x0 or y1 <= y0 or (x1 - x0) * (y1 - y0) / area < FIG_RASTER:
            continue
        dentro = sum(1 for p in palavras if x0 <= (p[0] + p[2]) / 2 <= x1 and y0 <= (p[1] + p[3]) / 2 <= y1)
        if exigir_texto and palavras and dentro / len(palavras) <= 0.5:
            continue
        if melhor is None or (x1 - x0) * (y1 - y0) > melhor[3]:
            melhor = ((x0, y0, x1, y1), info.get('width', 0), info.get('height', 0), (x1 - x0) * (y1 - y0))
    return melhor[:3] if melhor else None


def _render_cinza(pagina, pymupdf, rect, dpi):
    from PIL import Image
    pix = pagina.get_pixmap(clip=rect, dpi=dpi, colorspace=pymupdf.csGRAY)
    return Image.frombytes('L', (pix.width, pix.height), pix.samples)


def palavras_do_ocr(pagina, pymupdf, ocr, rect, confianca=REG_PALAVRA_CONF, so_palavras=True):
    """
    Palavras que o OCR leu dentro de `rect`, em pontos da folha: [(x0, y0, x1, y1, texto)]. Por padrão
    só as lidas com confiança e com cara de palavra (as que dizem "aqui é texto"); a legenda pede todas.
    """
    if ocr is None:
        return []
    img = _render_cinza(pagina, pymupdf, rect, OCR_DPI)
    escala = 72.0 / OCR_DPI
    try:
        d = ocr.image_to_data(img, lang=IDIOMA_OCR, output_type=ocr.Output.DICT)
    except Exception:                                            # noqa: BLE001
        return []
    out = []
    for i, t in enumerate(d.get('text', [])):
        t = (t or '').strip()
        try:
            conf = float(d['conf'][i])
        except (TypeError, ValueError):
            conf = -1
        if not t or conf < confianca:
            continue
        if so_palavras and (len(re.sub(r'\W', '', t)) < 2 or not RE_PALAVRA.match(t) or not RE_VOGAL.search(t)):
            continue
        x, y, w, h = d['left'][i], d['top'][i], d['width'][i], d['height'][i]
        out.append((rect.x0 + x * escala, rect.y0 + y * escala, rect.x0 + (x + w) * escala, rect.y0 + (y + h) * escala, t))
    return out


def _tirar_blocos(grade, caixas, bloco, ox, oy):
    """Tira da grade os blocos cobertos (REG_PALAVRA_COBRE) pelas caixas, em pontos (origem ox, oy)."""
    L, C = len(grade), len(grade[0])
    cobre = {}
    for x0, y0, x1, y1 in caixas:
        for li in range(max(0, int((y0 - oy) // bloco)), min(L, int((y1 - oy) // bloco) + 1)):
            for co in range(max(0, int((x0 - ox) // bloco)), min(C, int((x1 - ox) // bloco) + 1)):
                bx0, by0 = ox + co * bloco, oy + li * bloco
                ix = min(x1, bx0 + bloco) - max(x0, bx0)
                iy = min(y1, by0 + bloco) - max(y0, by0)
                if ix > 0 and iy > 0:
                    cobre[(li, co)] = cobre.get((li, co), 0) + ix * iy
    for (li, co), a in cobre.items():
        if a / (bloco * bloco) >= REG_PALAVRA_COBRE:
            grade[li][co] = False


def legenda_por_ocr(pagina, pymupdf, ocr, bbox):
    """A legenda logo abaixo (ou, sem ela, logo acima) da região, lida por OCR na mesma coluna."""
    if ocr is None:
        return None
    x0, y0, x1, y1 = bbox
    faixas = [('abaixo', pymupdf.Rect(x0, y1, x1, min(pagina.rect.y1, y1 + LEGENDA_ABAIXO))),
              ('acima', pymupdf.Rect(x0, max(pagina.rect.y0, y0 - LEGENDA_ACIMA), x1, y0))]
    for lado, rect in faixas:
        if rect.height < 6:
            continue
        palavras = palavras_do_ocr(pagina, pymupdf, ocr, rect, confianca=0, so_palavras=False)
        if not palavras:
            continue
        # A linha mais perto da foto (a de cima, abaixo dela; a de baixo, acima dela) e as da mesma
        # linha de texto: palavras com o centro vertical a menos de meia altura de linha.
        palavras.sort(key=lambda p: (p[1] if lado == 'abaixo' else -p[3], p[0]))
        ref = palavras[0]
        altura = max(4.0, ref[3] - ref[1])
        centro = (ref[1] + ref[3]) / 2
        linha = sorted((p for p in palavras if abs((p[1] + p[3]) / 2 - centro) <= altura * 0.6), key=lambda p: p[0])
        util = texto_util(' '.join(p[4] for p in linha))
        if len(util) >= 4 and not parece_ruido(util):
            return util if len(util) <= LEGENDA_MAX else util[:LEGENDA_MAX - 1].rstrip() + '…'
    return None


def ajustar_bordas(img, papel, bbox, ox, oy, passo=REG_BLOCO):
    """
    O retângulo de blocos fica por dentro da foto (o bloco da borda, meio foto e meio papel, não passa
    no teste de papel). Cada lado avança até um bloco para fora, linha a linha de pixels, enquanto a
    linha é mais foto que papel.
    """
    w, h = img.size
    x0, y0, x1, y1 = (int(round(bbox[0] - ox)), int(round(bbox[1] - oy)), int(round(bbox[2] - ox)), int(round(bbox[3] - oy)))

    def papel_na(caixa):
        hist = img.crop(caixa).histogram()
        return sum(hist[papel:]) / (sum(hist) or 1)
    for _ in range(passo):
        if y0 > 0 and papel_na((x0, y0 - 1, x1, y0)) < 0.5:
            y0 -= 1
        if y1 < h and papel_na((x0, y1, x1, y1 + 1)) < 0.5:
            y1 += 1
        if x0 > 0 and papel_na((x0 - 1, y0, x0, y1)) < 0.5:
            x0 -= 1
        if x1 < w and papel_na((x1, y0, x1 + 1, y1)) < 0.5:
            x1 += 1
    return (ox + x0, oy + y0, ox + x1, oy + y1)


def regioes_de_foto(pagina, pymupdf, ocr, evitar=(), com_legenda=True, origem='ocr'):
    """
    Regiões de fotografia dentro da folha digitalizada, na ordem de leitura: `[{bbox, fracao, largura,
    altura, xref: 0, legenda, origem: 'regiao_escaneada'}]`. `evitar`: bboxes de figuras embutidas já
    recortadas na folha. `origem`: a da folha na conversão (`nativo` só conta como digitalizada com o
    texto por cima do scan). Sem imagem de folha inteira, nada: a folha de texto nativo não tem scan.
    """
    palavras_nativas = pagina.get_text('words')
    folha = imagem_da_folha(pagina, palavras_nativas, exigir_texto=origem != 'ocr')
    if folha is None:
        return []
    (fx0, fy0, fx1, fy1), fw, fh = folha
    # Pixels da imagem original por ponto da folha: o piso de 200 px é na resolução do scan.
    escala_px = min(fw / max(1.0, fx1 - fx0), fh / max(1.0, fy1 - fy0)) if fw and fh else OCR_DPI / 72.0
    img = _render_cinza(pagina, pymupdf, pagina.rect, REG_DPI)
    ox, oy = pagina.rect.x0, pagina.rect.y0
    bloco = REG_BLOCO
    grade, stats, papel = grade_de_foto(img, bloco)
    # A camada de texto do PDF (folha pesquisável, rodapé do sistema) e as figuras embutidas já vistas
    # saem antes de juntar: palavra nativa é texto com certeza, e a figura embutida já tem recorte.
    _tirar_blocos(grade, [p[:4] for p in palavras_nativas if RE_PALAVRA.match(p[4]) and RE_VOGAL.search(p[4])], bloco, ox, oy)
    _tirar_blocos(grade, list(evitar), bloco, ox, oy)
    area = float(pagina.rect.width * pagina.rect.height) or 1.0

    def candidatas(g):
        out = []
        for caixa in (parte for comp in componentes(g) for parte in separar_por_calhas(g, comp)):
            l0, c0, l1, c1 = caixa
            bbox = (ox + c0 * bloco, oy + l0 * bloco, ox + (c1 + 1) * bloco, oy + (l1 + 1) * bloco)
            w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
            preenchimento, tons, textura = medir_regiao(g, stats, caixa)
            # O piso de 200 px é medido na densidade de leitura do conversor (OCR_DPI): num scan de
            # 100 dpi (comum no PJe) a foto de 6 x 4,5 cm tem 240 x 180 px, e o piso na resolução do
            # scan a cortava pelo ajuste do scanner, não pelo tamanho da foto na folha.
            if eh_regiao_de_foto(fracao=w * h / area, largura=w * OCR_DPI / 72.0, altura=h * OCR_DPI / 72.0,
                                 proporcao=max(w, h) / min(w, h), preenchimento=preenchimento,
                                 tons=tons, textura=textura):
                out.append(bbox)
        return out

    achadas = []
    for bbox in candidatas(grade):
        # O OCR confirma: bloco coberto por palavra lida com confiança é texto (tabela sombreada,
        # formulário com fundo, carimbo com dizeres), e a região é medida de novo sem ele.
        rect = pymupdf.Rect(bbox) & pagina.rect
        palavras = palavras_do_ocr(pagina, pymupdf, ocr, rect)
        if palavras:
            sub = [row[:] for row in grade]
            _tirar_blocos(sub, [p[:4] for p in palavras], bloco, ox, oy)
            l0, c0 = int((bbox[1] - oy) // bloco), int((bbox[0] - ox) // bloco)
            l1, c1 = int((bbox[3] - oy) // bloco) - 1, int((bbox[2] - ox) // bloco) - 1
            for li in range(len(sub)):
                for co in range(len(sub[0])):
                    if not (l0 <= li <= l1 and c0 <= co <= c1):
                        sub[li][co] = False
            achadas += candidatas(sub)
        else:
            achadas.append(bbox)
    blocos_nativos = pagina.get_text('blocks') if com_legenda else []
    out = []
    for bbox in achadas:
        bbox = ajustar_bordas(img, papel, bbox, ox, oy)
        bbox = (max(bbox[0], fx0), max(bbox[1], fy0), min(bbox[2], fx1), min(bbox[3], fy1))
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w <= 0 or h <= 0:
            continue
        out.append({'bbox': bbox, 'fracao': round(w * h / area, 4), 'largura': int(round(w * escala_px)),
                    'altura': int(round(h * escala_px)), 'xref': 0,
                    # A legenda da camada de texto (folha pesquisável) antes da lida por OCR.
                    'legenda': (legenda_proxima(blocos_nativos, bbox) or legenda_por_ocr(pagina, pymupdf, ocr, bbox))
                               if com_legenda else None,
                    'origem': 'regiao_escaneada'})
    out.sort(key=lambda f: (round(f['bbox'][1] / 10), f['bbox'][0]))
    return out


def figuras_de_uma_folha(doc, pagina, n, origem, repeticoes, destino, pymupdf, ocr):
    """
    Figuras de uma folha, recortadas em `destino/imagens/figura-NNNN-K.jpg`: primeiro as embutidas,
    depois as regiões de foto da folha escaneada (só em folha `ocr`, ou `nativo` pesquisável com a
    digitalização por baixo; a folha `imagem` já vai inteira ao descritor). Devolve os itens do
    manifesto, na ordem de K.
    """
    embutidas = [dict(f, origem='embutida') for f in figuras_da_pagina(pagina, repeticoes, origem)]
    for f in embutidas:
        # Legenda que não está na camada de texto (o título dentro de outra imagem, a folha montada
        # como figura): lida por OCR logo abaixo ou acima, como a da foto de folha escaneada.
        if not f['legenda']:
            f['legenda'] = legenda_por_ocr(pagina, pymupdf, ocr, f['bbox'])
    regioes = []
    if origem in ('ocr', 'nativo'):
        try:
            regioes = regioes_de_foto(pagina, pymupdf, ocr, evitar=[f['bbox'] for f in embutidas], origem=origem)
        except Exception as e:                                   # noqa: BLE001
            print(f'  aviso: regiões de foto da folha {n} não foram medidas ({e})', file=sys.stderr)
    itens = []
    for k, fig in enumerate(embutidas + regioes, start=1):
        jpg = destino / 'imagens' / f'figura-{n:04d}-{k}.jpg'
        try:
            _, _, exif = gravar_figura(doc, pagina, fig, jpg, pymupdf)
        except Exception as e:                                   # noqa: BLE001
            print(f'  aviso: figura {k} da folha {n} não foi recortada ({e})', file=sys.stderr)
            continue
        item = {'pagina': n, 'figura': k, 'imagem': f'imagens/{jpg.name}', 'fracao': fig['fracao'],
                'largura': fig['largura'], 'altura': fig['altura'], 'legenda': fig['legenda']}
        if exif:
            item['exif'] = exif
        item['origem'] = fig['origem']
        itens.append(item)
    return itens


def linha_de_figuras(figuras):
    """A linha do topo do documento.md que conta as figuras (None sem figura)."""
    if not figuras:
        return None
    reg = sum(1 for f in figuras if f.get('origem') == 'regiao_escaneada')
    detalhe = f' ({len(figuras) - reg} embutida(s), {reg} recortada(s) de folha escaneada)' if reg else ' embutida(s)'
    return (f'> {len(figuras)} figura(s){detalhe} (foto, print, planta, gráfico) em '
            f'{len({f["pagina"] for f in figuras})} folha(s), recortadas em `imagens/figura-NNNN-K.jpg`. '
            'A descrição de cada uma entra no fim da folha, entre `<!-- figura:begin -->` e '
            '`<!-- figura:end -->`: interpretação de máquina, que se confere na imagem; a peça cita '
            'a folha, nunca a descrição.')


# O que falta, dito em português e com o comando que resolve: `pip install` direto falha no Python
# do Homebrew e de várias distribuições (PEP 668), e foi assim que a primeira conversão do teste com
# autos reais de 27/09/2026 parou. O `--deps` cria um ambiente virtual do projeto e instala lá.
MSG_SEM_PYMUPDF = (
    'falta o PyMuPDF, a biblioteca que lê o PDF: a conversão não começou. Prepare o ambiente do '
    'projeto uma vez com `npm run autos:md:deps` (ou `node scripts/autos-md.mjs --deps`): ele cria '
    '`_legalsquad/.venv` e instala PyMuPDF, pymupdf4llm, pytesseract e Pillow ali, sem mexer no Python '
    'da máquina. Depois converta de novo com `npm run autos:md -- <squads/nome ou pasta do caso>`.'
)
# Código de saída próprio: quem chama (`autos-md.mjs`, o runner) sabe que é dependência, não o PDF.
SAIDA_SEM_DEPENDENCIA = 3


def carregar_deps(com_ocr):
    try:
        import pymupdf
    except ImportError:
        sair(MSG_SEM_PYMUPDF, codigo=SAIDA_SEM_DEPENDENCIA)
    ocr = None
    if com_ocr:
        try:
            import pytesseract
            pytesseract.get_tesseract_version()
            ocr = pytesseract
        except Exception as e:                                   # noqa: BLE001
            print(f'  aviso: OCR indisponível ({e}); páginas sem texto sairão como `vazia`',
                  file=sys.stderr)
    return pymupdf, ocr


def limpar(md):
    """
    Normaliza o Markdown do extrator sem apagar procedência.

    O `pymupdf4llm` devolve o texto lido DENTRO de imagens como uma linha só,
    com `<br>` no lugar das quebras, entre comentários `picture text`. Empilhado
    assim o parágrafo vira uma linha de 2 mil caracteres: ilegível para quem lê e
    inútil para `grep -n`, que devolveria a folha inteira numa linha. Os
    comentários FICAM — são invisíveis no render e dizem que aquele trecho veio
    de imagem, o que muda o peso da citação.
    """
    md = re.sub(r'<br\s*/?>', '\n', md)
    return re.sub(r'\n{3,}', '\n\n', md)


def markdown_por_pagina(doc, pymupdf, total, bloco=BLOCO, com_imagens=False, com_ocr=True):
    """
    Markdown por página via pymupdf4llm; cai para texto cru se ele falhar.

    Em BLOCOS, e não o documento inteiro de uma vez. Chamado sobre as 707 folhas
    de um processo real, o `to_markdown` ficou 10 minutos sem devolver nada:
    nenhum sinal de progresso, memória crescendo, e um erro no fim jogaria fora
    o trabalho todo. Processo de centenas de folhas é o caso NORMAL deste
    domínio, não o extremo — então o laço é por bloco, o progresso aparece, e o
    que já foi convertido sobrevive à falha do bloco seguinte.

    Recebe o Document JÁ ABERTO, não o caminho: passando o caminho, cada bloco
    reabria e reparseava os 61 MB do processo inteiro, e as 29 chamadas ficaram
    mais lentas do que a chamada única que o bloco veio consertar.

    `ignore_images` por padrão. Medido no mesmo bloco de 25 folhas do processo
    real: **63,4 s com imagens contra 25,2 s sem, e os DOIS devolveram 94.952
    caracteres** — mesma saída, 2,5× o tempo. O que se perde é o texto lido
    dentro de figura numa folha que JÁ tem camada de texto; as folhas que só têm
    imagem continuam cobertas, porque são exatamente as que este script manda ao
    OCR por conta própria, com a marcação de procedência. `--com-imagens`
    restaura o caminho caro para quem precisar dele num caso específico.
    """
    try:
        import pymupdf4llm
    except Exception as e:                                       # noqa: BLE001
        print(f'  aviso: pymupdf4llm indisponível ({e}); usando extração de texto simples',
              file=sys.stderr)
        return [doc.load_page(i).get_text() for i in range(total)], 'pymupdf-texto'

    # O extrator novo (1.x) faz OCR por conta própria nas folhas sem camada de texto
    # (`use_ocr=True` por padrão); `--sem-ocr` tem de valer também para ele, senão a flag
    # não pula OCR nenhum. Versões antigas não conhecem o parâmetro: tenta com, cai sem.
    opcoes = {'page_chunks': True, 'show_progress': False, 'ignore_images': not com_imagens}
    com_uso_de_ocr = [{'use_ocr': com_ocr}, {}]
    textos, motor = [], 'pymupdf4llm'
    for inicio in range(0, total, bloco):
        fim = min(inicio + bloco, total)
        try:
            chunks = None
            for extra in com_uso_de_ocr:
                try:
                    chunks = pymupdf4llm.to_markdown(doc, pages=list(range(inicio, fim)), **opcoes, **extra)
                    break
                except TypeError:
                    if not extra:
                        raise
                    com_uso_de_ocr = [{}]
            textos += [c.get('text', '') for c in chunks]
        except Exception as e:                                   # noqa: BLE001
            # Bloco que falha não derruba o documento: cai para texto cru NESTE
            # trecho e segue. O manifesto continua dizendo a procedência folha a
            # folha, então a degradação é visível, não silenciosa.
            print(f'  aviso: folhas {inicio + 1}-{fim} falharam no pymupdf4llm ({e}); texto simples',
                  file=sys.stderr)
            textos += [doc.load_page(i).get_text() for i in range(inicio, fim)]
            motor = 'pymupdf4llm+fallback'
        print(f'  extraídas {min(len(textos), total)}/{total} folhas...', file=sys.stderr, flush=True)
    return textos, motor


def bloco_de_figura(pagina, figura, imagem, legenda):
    """
    O lugar da descrição no Markdown da folha, entre marcadores que o `sumario-autos.mjs integrar`
    reescreve (só eles). `figura` 0 é a folha inteira de imagem; 1 em diante, as figuras embutidas.
    """
    quem = f'Imagem da fls. {pagina}' if figura == 0 else f'Figura {figura} da fls. {pagina}'
    leg = f' Legenda próxima: "{legenda}".' if legenda else ''
    return (f'<!-- figura:begin fls={pagina} fig={figura} -->\n'
            f'> **{quem}** (`{imagem}`), ainda sem descrição.{leg} O descritor de imagens a descreve na '
            'fase zero, e o `sumario-autos.mjs integrar` traz a descrição para cá.\n'
            '<!-- figura:end -->')


def classificar(*, util_nativo, util_lido, ocr_rodou, fracao, ruido=False):
    """
    Origem de uma folha SEM camada de texto útil, decidida uma vez só, pelo que foi lido.

    `util_nativo`: caracteres úteis da camada de texto do PDF (abaixo de MIN_TEXTO aqui).
    `util_lido`: caracteres úteis do texto reconhecido por máquina (extrator ou tesseract).
    `ocr_rodou`: algum OCR foi tentado nesta folha. `fracao`: área da página coberta por imagem.

    - Texto reconhecido longo é `ocr`. Curto, numa folha em que a figura é uma parte da
      página (legenda, carimbo, data), é `imagem` com o trecho lido como pista; numa folha
      digitalizada inteira (fração ~1,0) a figura não diz nada, e um despacho curto é `ocr`.
    - Sem texto reconhecido: camada nativa curta e sem figura é uma capa ou um separador
      (`nativo`, com o texto que há); com figura é `imagem`; folha em que ninguém achou
      nada é `vazia`. Sem OCR disponível a folha sai `vazia`: não foi lida.
    - `ruido`: o OCR leu textura de foto como letra (`parece_ruido`). O que ele leu não é texto,
      e a folha com figura sai `imagem`: antes saía `ocr`, com lixo no lugar do conteúdo, e a foto
      nunca era vista.
    """
    figura = fracao >= AREA_IMAGEM
    parcial = figura and fracao < PAGINA_INTEIRA
    if ruido and figura:
        return 'imagem'
    if util_lido >= TEXTO_CURTO:
        return 'ocr'
    if util_lido >= MIN_TEXTO:
        return 'imagem' if parcial else 'ocr'
    if util_nativo > 0 and not figura:
        return 'nativo'
    if figura and (ocr_rodou or util_nativo > 0):
        return 'imagem'
    return 'vazia'


def converter(pdf_path, saida_dir, com_ocr=True, com_imagens=False, nome=None):
    pymupdf, ocr = carregar_deps(com_ocr)
    nome = nome or slug(pdf_path.name)
    destino = saida_dir / nome
    (destino / 'imagens').mkdir(parents=True, exist_ok=True)

    doc = pymupdf.open(str(pdf_path))
    total = doc.page_count
    # VERDADE DE BASE, medida ANTES de qualquer extração: quais folhas têm camada
    # de texto no PDF. Sem isto a procedência é chute — o `pymupdf4llm` roda OCR
    # por conta própria nas páginas escaneadas e devolve texto sem dizer de onde
    # veio, e a primeira versão deste script carimbou 73 folhas reconhecidas por
    # máquina como `nativo`. Afirmar procedência que não se verificou é o mesmo
    # defeito de citar precedente de memória, só que na camada de baixo.
    nativos = [doc.load_page(i).get_text() for i in range(total)]
    util_nativo = [len(texto_util(t)) for t in nativos]
    sem_camada = {i for i in range(total) if util_nativo[i] < MIN_TEXTO}
    print(f'  {total} folhas · {len(sem_camada)} sem camada de texto útil (irão a OCR)', file=sys.stderr)
    # Recortes de uma conversão anterior saem antes: figura que deixou de passar pelo filtro não
    # pode ficar na pasta parecendo lida.
    for velho in (destino / 'imagens').glob('figura-*.jpg'):
        velho.unlink()
    repeticoes = repeticoes_por_digest(doc)
    # As figuras saem de uma segunda abertura do PDF, intocada: o OCR do extrator grava uma camada de
    # texto nas folhas digitalizadas do Document aberto, e a detecção dependia disso. Assim a conversão
    # e a passada de figuras (`--figuras`, sem OCR) acham exatamente as mesmas figuras.
    doc_figuras = pymupdf.open(str(pdf_path))

    textos, motor = markdown_por_pagina(doc, pymupdf, total, com_imagens=com_imagens, com_ocr=com_ocr)
    if len(textos) < total:
        textos += [''] * (total - len(textos))

    blocos, manifesto, figuras = [], [], []
    falha_ocr = None
    for i in range(total):
        n = i + 1
        pagina = doc.load_page(i)
        # O texto GRAVADO nunca passa pelo `texto_util`: ele colapsa as quebras de linha (a
        # folha viraria uma linha só, inútil para `grep -n`) e apaga o rodapé, que fica
        # como está. Só a MEDIÇÃO desconta rodapé e lixo de figura.
        texto = limpar(textos[i] or '').strip()
        imagem = None
        if i not in sem_camada:
            origem = 'nativo'
        else:
            # A folha não tem texto no PDF. O que houver aqui foi reconhecido por
            # máquina — pelo extrator ou por nós — e sai marcado como tal.
            png = destino / 'imagens' / f'pagina-{n:04d}.jpg'
            pagina.get_pixmap(dpi=OCR_DPI).pil_save(str(png), format='JPEG',
                                                    quality=IMG_QUALIDADE, optimize=True)
            imagem = f'imagens/{png.name}'
            lido, ocr_rodou = texto, len(texto_util(texto)) >= MIN_TEXTO
            if not ocr_rodou and ocr is not None:
                from PIL import Image
                ocr_rodou = True
                try:
                    lido = limpar(ocr.image_to_string(Image.open(png), lang=IDIOMA_OCR)).strip()
                except Exception as e:                           # noqa: BLE001
                    lido, ocr_rodou = texto, False
                    if falha_ocr is None:
                        falha_ocr = str(e).strip().splitlines()[0] if str(e).strip() else repr(e)
                        print(f'  aviso: OCR falhou na folha {n} ({falha_ocr}); folhas sem texto '
                              'sairão como `vazia` até o tesseract funcionar', file=sys.stderr)
            ruido = len(texto_util(lido)) >= MIN_TEXTO and parece_ruido(lido)
            origem = classificar(util_nativo=util_nativo[i], util_lido=len(texto_util(lido)),
                                 ocr_rodou=ocr_rodou, fracao=fracao_de_imagem(pagina), ruido=ruido)
            if origem == 'nativo':
                pass                    # capa ou separador: o texto curto do PDF é o que há
            elif origem == 'vazia':
                texto = ''
            elif ruido:
                # O que o OCR "leu" era a textura da foto: não é texto, e não vai para o Markdown.
                texto = texto_util(nativos[i])
            elif len(texto_util(lido)) >= MIN_TEXTO:
                texto = lido            # texto reconhecido, com as quebras de linha que o OCR deu
            else:
                # Folha de imagem: só a pista curta (legenda, carimbo, data), nunca o rodapé
                # do sistema que o OCR leu na moldura e que passaria por conteúdo.
                texto = texto_util(lido) or texto_util(texto)

        pje = rodape_pje(nativos[i]) or rodape_pje(texto)
        titulo = f'## fls. {n} · Num. {pje[0]} - Pág. {int(pje[1])}' if pje else f'## fls. {n}'
        cabecalho = [f'<!-- fls. {n}/{total} · origem: {origem} -->', '', titulo, '']
        if origem == 'ocr':
            cabecalho += ['> **Texto reconhecido por OCR, não nativo do PDF.** Confira na imagem '
                          f'(`{imagem}`) antes de citar esta folha.', '']
        elif origem == 'imagem':
            cabecalho += ['> **Folha de imagem (foto, nota, documento escaneado) sem texto legível'
                          + (' além do trecho abaixo, lido por OCR' if texto else '') + '.** '
                          f'A página está em `{imagem}`; a descrição, quando houver, entra no fim '
                          'desta folha como bloco marcado (interpretação de máquina). Cite a folha '
                          'como imagem, nunca a descrição.', '']
        elif origem == 'vazia':
            cabecalho += ['> **Sem texto extraível.** Nada foi reconhecido nesta folha; a página '
                          f'está em `{imagem}` para leitura visual. Não há conteúdo a citar daqui.', '']
        # Figuras embutidas da folha, em qualquer origem: a foto dentro de um laudo com texto é a
        # lacuna que a classificação por folha não fecha.
        marcados = []
        for item in figuras_de_uma_folha(doc_figuras, doc_figuras.load_page(i), n, origem, repeticoes, destino, pymupdf, ocr):
            figuras.append(item)
            marcados.append(bloco_de_figura(n, item['figura'], item['imagem'], item['legenda']))
        if origem == 'imagem' and not marcados:
            marcados.append(bloco_de_figura(n, 0, imagem, None))
        corpo = texto + '\n' if texto else ''
        if marcados:
            corpo += '\n' + '\n'.join(marcados) + '\n'
        blocos.append('\n'.join(cabecalho) + corpo)
        manifesto.append({'pagina': n, 'origem': origem, 'caracteres': len(texto),
                          'imagem': imagem})
        if n % 100 == 0 or n == total:
            print(f'  montadas {n}/{total} folhas...', file=sys.stderr, flush=True)
    doc.close()
    doc_figuras.close()

    contagem = {o: sum(1 for m in manifesto if m['origem'] == o) for o in ('nativo', 'ocr', 'imagem', 'vazia')}
    topo = [
        f'# {pdf_path.name}',
        '',
        f'> Convertido de PDF em {datetime.now(timezone.utc).isoformat(timespec="seconds")} '
        f'por `autos-para-md.py` ({motor}).',
        f'> {total} folhas: {contagem["nativo"]} com texto nativo, {contagem["ocr"]} por OCR, '
        f'{contagem["imagem"]} de imagem sem texto legível, {contagem["vazia"]} sem texto extraível.',
        '> Cada folha abre com `## fls. N` (no PDF integral do PJe, `## fls. N · Num. X - Pág. Y`: a '
        'folha do PDF e o documento do PJe, como o tribunal cita). **Cite a folha, nunca de memória**; '
        'o que veio de OCR está marcado folha a folha e exige conferência na imagem.',
    ]
    if figuras:
        topo.append(linha_de_figuras(figuras))
    topo.append('')
    (destino / 'documento.md').write_text('\n'.join(topo) + '\n'.join(blocos), encoding='utf-8')
    # `ocr` diz o que aconteceu com as folhas sem camada de texto: `tesseract` (lidas),
    # `indisponivel` (tesseract ausente: saíram `vazia` sem ninguém as ler) ou `desligado`
    # (`--sem-ocr`). O indexador usa isto para dizer se o que falta é OCR ou leitura visual.
    ocr_do_run = 'tesseract' if ocr is not None else ('desligado' if not com_ocr else 'indisponivel')
    (destino / '_manifesto.json').write_text(json.dumps({
        'arquivo': pdf_path.name, 'paginas': total, 'motor': motor, 'ocr': ocr_do_run,
        'convertido_em': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'contagem': contagem, 'folhas': manifesto, 'figuras': figuras, 'figuras_versao': FIGURAS_VERSAO,
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    return destino, total, dict(contagem, **contar_figuras(figuras))


def contar_figuras(figuras):
    reg = sum(1 for f in figuras if f.get('origem') == 'regiao_escaneada')
    return {'figuras': len(figuras), 'embutidas': len(figuras) - reg, 'regioes': reg}


RE_SECAO_FOLHA = re.compile(r'(?=^<!-- fls\. \d+/\d+)', re.MULTILINE)
RE_BLOCO_FIGURA = re.compile(r'<!-- figura:begin fls=(\d+) fig=(\d+) -->\n.*?\n<!-- figura:end -->\n?', re.DOTALL)
RE_LINHA_FIGURAS = re.compile(r'^> \d+ figura\(s\) ')


def reescrever_figuras(md, blocos_por_folha, linha_topo):
    """
    O documento.md com os blocos de figura de cada folha trocados pelos de `blocos_por_folha`
    (`{folha: [(K, bloco)]}`), sem tocar no texto das folhas. O bloco que já tem descrição (o
    `sumario-autos.mjs integrar` a trouxe) fica como está; o que ainda espera descrição é refeito.
    Folha cujos blocos não mudam sai byte a byte igual. Mesma forma de seção do `integrar`.
    """
    partes = RE_SECAO_FOLHA.split(md)
    saida = []
    for idx, secao in enumerate(partes):
        m = re.match(r'<!-- fls\. (\d+)/', secao)
        if not m:
            if idx == 0:
                linhas = [l for l in secao.split('\n') if not RE_LINHA_FIGURAS.match(l)]
                if linha_topo:
                    fim = len(linhas) - 1 if linhas and linhas[-1] == '' else len(linhas)
                    linhas.insert(fim, linha_topo)
                secao = '\n'.join(linhas)
            saida.append(secao)
            continue
        n = int(m.group(1))
        existentes = {int(b.group(2)): b.group(0).rstrip('\n') for b in RE_BLOCO_FIGURA.finditer(secao)}
        desejados = []
        for k, bloco in blocos_por_folha.get(n, []):
            atual = existentes.get(k)
            desejados.append(atual if atual is not None and 'ainda sem descrição' not in atual else bloco)
        if list(existentes.values()) == desejados:
            saida.append(secao)
            continue
        base = RE_BLOCO_FIGURA.sub('', secao).rstrip()
        ultima = idx == len(partes) - 1
        corpo = base + ('\n\n' + '\n'.join(desejados) + '\n' if desejados else '\n')
        saida.append(corpo + ('' if ultima else '\n'))
    return ''.join(saida)


def passada_de_figuras(pdf_path, destino):
    """
    Só as figuras, sobre autos JÁ convertidos: abre o PDF de origem, recorta as figuras embutidas e as
    regiões de foto das folhas escaneadas, grava `figuras` no manifesto e os blocos no documento.md.
    Não refaz o OCR, não reclassifica folha, não toca no texto: a origem de cada folha vem do
    manifesto da conversão. Devolve a contagem, ou `(None, motivo)` quando não há o que passar.
    """
    pymupdf, ocr = carregar_deps(True)
    man_path, md_path = destino / '_manifesto.json', destino / 'documento.md'
    if not man_path.is_file() or not md_path.is_file():
        return None, 'ainda não convertido (sem _manifesto.json ou documento.md): converta com `npm run autos:md`'
    manifesto = json.loads(man_path.read_text(encoding='utf-8'))
    doc = pymupdf.open(str(pdf_path))
    total = doc.page_count
    if manifesto.get('paginas') != total:
        doc.close()
        return None, (f'o PDF tem {total} folhas e a conversão, {manifesto.get("paginas")}: o arquivo mudou, '
                      'reconverta com `npm run autos:md`')
    folhas = {f.get('pagina'): f for f in manifesto.get('folhas') or [] if isinstance(f, dict)}
    (destino / 'imagens').mkdir(parents=True, exist_ok=True)
    for velho in (destino / 'imagens').glob('figura-*.jpg'):
        velho.unlink()
    repeticoes = repeticoes_por_digest(doc)
    figuras, blocos = [], {}
    for i in range(total):
        n = i + 1
        folha = folhas.get(n) or {}
        itens = figuras_de_uma_folha(doc, doc.load_page(i), n, folha.get('origem'), repeticoes, destino, pymupdf, ocr)
        figuras += itens
        desejados = [(it['figura'], bloco_de_figura(n, it['figura'], it['imagem'], it['legenda'])) for it in itens]
        if folha.get('origem') == 'imagem' and not itens and folha.get('imagem'):
            desejados = [(0, bloco_de_figura(n, 0, folha['imagem'], None))]
        blocos[n] = desejados
        if n % 100 == 0 or n == total:
            print(f'  figuras: {n}/{total} folhas...', file=sys.stderr, flush=True)
    doc.close()
    texto = md_path.read_text(encoding='utf-8')
    novo = reescrever_figuras(texto, blocos, linha_de_figuras(figuras))
    if novo != texto:
        md_path.write_text(novo, encoding='utf-8')
    # Só `figuras` e `figuras_versao` mudam: o resto do manifesto (folhas, contagem, OCR) é da
    # conversão, e o hash da leitura que o sumário do caso guarda não conta as figuras. A lista que a
    # 0.9.75 gravou (figuras sem `figuras_versao`) fica em `figuras_anteriores`: o sumário marcado nela
    # guardou um hash que contava aquelas figuras, e é com elas que o `sumario-autos` o confere.
    if isinstance(manifesto.get('figuras'), list) and 'figuras_versao' not in manifesto \
            and 'figuras_anteriores' not in manifesto:
        manifesto['figuras_anteriores'] = manifesto['figuras']
    manifesto['figuras'] = figuras
    manifesto['figuras_versao'] = FIGURAS_VERSAO
    man_path.write_text(json.dumps(manifesto, ensure_ascii=False, indent=2), encoding='utf-8')
    return contar_figuras(figuras), None


def processar_avulsas(autos, saida):
    """
    Imagens juntadas à pasta dos autos (fotos do celular, prints): o inventário com o que o EXIF
    diz e, quando a leitura visual não abre o formato (HEIC, TIFF, BMP) ou a foto é grande demais,
    uma cópia JPG em `_md/_imagens-avulsas/`. Grava `_md/_imagens-avulsas.json`; sem avulsas, apaga
    o de uma conversão anterior. Devolve a lista.
    """
    try:
        from PIL import Image, ImageOps
    except ImportError:
        print('  aviso: sem Pillow, as imagens avulsas não foram inventariadas', file=sys.stderr)
        return []
    try:
        import pillow_heif                                       # opcional: HEIC sem o `sips`
        pillow_heif.register_heif_opener()
    except Exception:                                            # noqa: BLE001
        pass
    import shutil
    import subprocess
    import tempfile
    json_path = saida / AVULSAS_JSON
    copias = saida / AVULSAS_DIR
    itens = []
    for caminho in sorted(listar_pdfs(autos, EXT_AVULSA), key=lambda p: str(p.relative_to(autos))):
        rel = caminho.relative_to(autos).as_posix()
        item = {'imagem': rel, 'abrir': rel, 'largura': None, 'altura': None, 'exif': None}
        origem = caminho
        tmp = None
        try:
            try:
                img = Image.open(origem)
                img.load()
            except Exception:                                    # noqa: BLE001
                # HEIC sem pillow-heif: o macOS converte com o `sips`, que já vem no sistema.
                if caminho.suffix.lower() in ('.heic', '.heif') and shutil.which('sips'):
                    tmp = Path(tempfile.mkdtemp()) / 'conv.jpg'
                    subprocess.run(['sips', '-s', 'format', 'jpeg', str(caminho), '--out', str(tmp)],
                                   capture_output=True, check=True)
                    img = Image.open(tmp)
                    img.load()
                else:
                    raise
            item['largura'], item['altura'] = img.size
            item['exif'] = exif_util(img)
            precisa_copia = caminho.suffix.lower() not in EXT_LEGIVEL or max(img.size) > FIG_LADO_MAX * 2
            if precisa_copia:
                copias.mkdir(parents=True, exist_ok=True)
                destino = copias / f'{slug(rel)}.jpg'
                vista = ImageOps.exif_transpose(img).convert('RGB')
                vista.thumbnail((FIG_LADO_MAX, FIG_LADO_MAX))
                vista.save(destino, format='JPEG', quality=IMG_QUALIDADE, optimize=True)
                item['abrir'] = f'_md/{AVULSAS_DIR}/{destino.name}'
        except Exception as e:                                   # noqa: BLE001
            item['abrir'] = None
            item['erro'] = (f'formato não lido ({caminho.suffix.lower()}): converta para JPG e junte de novo'
                            if caminho.suffix.lower() in ('.heic', '.heif') else f'imagem não abriu ({e})')
        finally:
            if tmp is not None:
                shutil.rmtree(tmp.parent, ignore_errors=True)
        itens.append(item)
    if itens:
        saida.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps({'imagens': itens}, ensure_ascii=False, indent=2), encoding='utf-8')
    elif json_path.exists():
        json_path.unlink()
    return itens


def listar_pdfs(autos, extensoes=('.pdf',)):
    """PDFs de `autos/`, recursivo, ignorando o que começa com `.` ou `_` (como o indexador)."""
    achados = []
    for caminho in autos.rglob('*'):
        rel = caminho.relative_to(autos)
        if any(parte.startswith(('.', '_')) for parte in rel.parts):
            continue
        if caminho.is_file() and caminho.suffix.lower() in extensoes:
            achados.append(caminho)
    return achados


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('alvo', help='pasta do squad (usa autos/) ou um arquivo .pdf')
    ap.add_argument('--saida', default=None, help='diretório de saída (default: <autos>/_md)')
    ap.add_argument('--sem-ocr', action='store_true', help='não tenta OCR nas páginas sem texto')
    ap.add_argument('--figuras', action='store_true',
                    help='só as figuras, sobre autos já convertidos: recorta as embutidas e as fotos de '
                         'folha escaneada e grava os blocos, sem refazer o OCR nem mudar o texto das folhas')
    ap.add_argument('--com-imagens', action='store_true',
                    help='também lê o texto dentro de figuras em folhas que já têm texto '
                         '(2,5x mais lento; medido sem ganho de conteúdo no caso de teste)')
    args = ap.parse_args()

    alvo = Path(args.alvo)
    if alvo.is_dir():
        autos = alvo if alvo.name == 'autos' and not (alvo / 'autos').is_dir() else alvo / 'autos'
        # Autos por referência: `squads/<nome>/caso.json` aponta a pasta do caso (relativa à raiz do
        # projeto, a pasta acima de squads/), como no indexador. Sem isto, o conversor dizia "sem
        # pasta autos/" para o squad criado com `--caso` (medido em 23/09/2026).
        if not autos.is_dir() and (alvo / 'caso.json').is_file():
            try:
                pasta = json.loads((alvo / 'caso.json').read_text(encoding='utf-8')).get('pasta')
            except (ValueError, OSError):
                pasta = None
            if isinstance(pasta, str) and pasta:
                autos = (alvo.resolve().parent.parent / pasta / 'autos')
        if not autos.is_dir():
            sair(f'sem pasta autos/ em {alvo}: nada a converter')
        # Os mesmos arquivos que `indexar-autos.mjs` indexa: subpastas incluídas, extensão em
        # qualquer caixa, pastas `_md`/`_texto`/`_sumario` e ocultas de fora. Sem isto o índice
        # cobrava a conversão de `LAUDO.PDF` e de `anexos/apolice.pdf` e o conversor não os via.
        pdfs = sorted(listar_pdfs(autos), key=lambda p: str(p.relative_to(autos)))
        saida = Path(args.saida) if args.saida else autos / '_md'
        nomes = {pdf: slug(str(pdf.relative_to(autos))) for pdf in pdfs}
    elif alvo.suffix.lower() == '.pdf' and alvo.is_file():
        pdfs, saida = [alvo], Path(args.saida) if args.saida else alvo.parent / '_md'
        nomes = {alvo: slug(alvo.name)}
    else:
        sair(f'{alvo} não é pasta de squad nem arquivo .pdf')

    # Fotos juntadas à pasta: inventário com o EXIF útil, antes e independente dos PDFs.
    avulsas = processar_avulsas(autos, saida) if alvo.is_dir() else []
    if avulsas:
        sem_leitura = sum(1 for a in avulsas if not a.get('abrir'))
        print(f'autos-para-md: {len(avulsas)} imagem(ns) avulsa(s) → {saida / AVULSAS_JSON}'
              + (f' ({sem_leitura} em formato não lido)' if sem_leitura else ''))

    if not pdfs and avulsas:
        sair(f'aviso: nenhum .pdf em autos/; {len(avulsas)} imagem(ns) avulsa(s) inventariada(s).', codigo=0)
    if not pdfs:
        # Autos só em texto (.md/.txt) não são falha: o indexador lê esses arquivos direto, e não
        # há o que converter. Sair com 1 fazia o chefe tratar como erro uma pasta pronta (medido
        # em 24/09/2026, mandado de segurança). Pasta sem nada legível continua sendo erro.
        textos = listar_pdfs(autos, ('.md', '.txt')) if alvo.is_dir() else []
        if textos:
            sair(f'aviso: nenhum .pdf em autos/, só {len(textos)} arquivo(s) de texto (.md/.txt), '
                 'que o indexador lê direto. Nada a converter.', codigo=0)
        sair('nenhum .pdf em autos/: nada a converter')

    if args.figuras:
        import time
        inicio, passados, pulados = time.monotonic(), 0, []
        for pdf in pdfs:
            print(f'  figuras de {pdf.name}...', file=sys.stderr)
            c, motivo = passada_de_figuras(pdf, saida / nomes[pdf])
            if c is None:
                pulados.append(pdf.name)
                print(f'autos-para-md: {pdf.name} pulado: {motivo}')
                continue
            passados += 1
            print(f'autos-para-md: {pdf.name} → {saida / nomes[pdf]}/documento.md (passada de figuras: '
                  f'{c["embutidas"]} figura(s) embutida(s), {c["regioes"]} foto(s) em folha escaneada; '
                  'texto das folhas intacto)')
        print(f'autos-para-md: passada de figuras em {time.monotonic() - inicio:.1f} s '
              f'({passados} documento(s){f", {len(pulados)} pulado(s)" if pulados else ""})')
        if not passados:
            sair('nenhum documento convertido para a passada de figuras: converta com `npm run autos:md` antes')
        return

    for pdf in pdfs:
        print(f'  convertendo {pdf.name}...', file=sys.stderr)
        destino, total, c = converter(pdf, saida, com_ocr=not args.sem_ocr, com_imagens=args.com_imagens,
                                      nome=nomes[pdf])
        print(f'autos-para-md: {pdf.name} → {destino}/documento.md '
              f'({total} folhas: {c["nativo"]} nativas, {c["ocr"]} OCR, {c["imagem"]} de imagem, '
              f'{c["vazia"]} sem texto; {c["embutidas"]} figura(s) embutida(s), {c["regioes"]} foto(s) em folha '
              'escaneada)')


if __name__ == '__main__':
    main()
