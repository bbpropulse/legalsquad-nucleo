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

Dependências (fora do Node, por isso um script à parte):
    pip install pymupdf4llm pytesseract Pillow      # + tesseract no PATH

Uso:
    python3 scripts/autos-para-md.py squads/<nome>            # todos os PDFs de autos/
    python3 scripts/autos-para-md.py squads/<nome> --sem-ocr  # pula o OCR
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


def carregar_deps(com_ocr):
    try:
        import pymupdf
    except ImportError:
        sair('PyMuPDF ausente: rode: pip install pymupdf4llm pytesseract Pillow')
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


def classificar(*, util_nativo, util_lido, ocr_rodou, fracao):
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
    """
    figura = fracao >= AREA_IMAGEM
    parcial = figura and fracao < PAGINA_INTEIRA
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
    util_nativo = [len(texto_util(doc.load_page(i).get_text())) for i in range(total)]
    sem_camada = {i for i in range(total) if util_nativo[i] < MIN_TEXTO}
    print(f'  {total} folhas · {len(sem_camada)} sem camada de texto útil (irão a OCR)', file=sys.stderr)

    textos, motor = markdown_por_pagina(doc, pymupdf, total, com_imagens=com_imagens, com_ocr=com_ocr)
    if len(textos) < total:
        textos += [''] * (total - len(textos))

    blocos, manifesto = [], []
    falha_ocr = None
    for i in range(total):
        n = i + 1
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
            pagina = doc.load_page(i)
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
            origem = classificar(util_nativo=util_nativo[i], util_lido=len(texto_util(lido)),
                                 ocr_rodou=ocr_rodou, fracao=fracao_de_imagem(pagina))
            if origem == 'nativo':
                pass                    # capa ou separador: o texto curto do PDF é o que há
            elif origem == 'vazia':
                texto = ''
            elif len(texto_util(lido)) >= MIN_TEXTO:
                texto = lido            # texto reconhecido, com as quebras de linha que o OCR deu
            else:
                # Folha de imagem: só a pista curta (legenda, carimbo, data), nunca o rodapé
                # do sistema que o OCR leu na moldura e que passaria por conteúdo.
                texto = texto_util(lido) or texto_util(texto)

        cabecalho = [f'<!-- fls. {n}/{total} · origem: {origem} -->', '', f'## fls. {n}', '']
        if origem == 'ocr':
            cabecalho += ['> **Texto reconhecido por OCR, não nativo do PDF.** Confira na imagem '
                          f'(`{imagem}`) antes de citar esta folha.', '']
        elif origem == 'imagem':
            cabecalho += ['> **Folha de imagem (foto, nota, documento escaneado) sem texto legível'
                          + (' além do trecho abaixo, lido por OCR' if texto else '') + '.** '
                          f'A página está em `{imagem}`; a descrição, quando houver, fica em '
                          '`_sumario/imagens/` (interpretação de máquina). Cite a folha como imagem, '
                          'nunca a descrição.', '']
        elif origem == 'vazia':
            cabecalho += ['> **Sem texto extraível.** Nada foi reconhecido nesta folha; a página '
                          f'está em `{imagem}` para leitura visual. Não há conteúdo a citar daqui.', '']
        blocos.append('\n'.join(cabecalho) + (texto + '\n' if texto else ''))
        manifesto.append({'pagina': n, 'origem': origem, 'caracteres': len(texto),
                          'imagem': imagem})
        if n % 100 == 0 or n == total:
            print(f'  montadas {n}/{total} folhas...', file=sys.stderr, flush=True)
    doc.close()

    contagem = {o: sum(1 for m in manifesto if m['origem'] == o) for o in ('nativo', 'ocr', 'imagem', 'vazia')}
    topo = [
        f'# {pdf_path.name}',
        '',
        f'> Convertido de PDF em {datetime.now(timezone.utc).isoformat(timespec="seconds")} '
        f'por `autos-para-md.py` ({motor}).',
        f'> {total} folhas: {contagem["nativo"]} com texto nativo, {contagem["ocr"]} por OCR, '
        f'{contagem["imagem"]} de imagem sem texto legível, {contagem["vazia"]} sem texto extraível.',
        '> Cada folha abre com `## fls. N`. **Cite a folha, nunca de memória**; o que veio de OCR '
        'está marcado folha a folha e exige conferência na imagem.',
        '',
    ]
    (destino / 'documento.md').write_text('\n'.join(topo) + '\n'.join(blocos), encoding='utf-8')
    # `ocr` diz o que aconteceu com as folhas sem camada de texto: `tesseract` (lidas),
    # `indisponivel` (tesseract ausente: saíram `vazia` sem ninguém as ler) ou `desligado`
    # (`--sem-ocr`). O indexador usa isto para dizer se o que falta é OCR ou leitura visual.
    ocr_do_run = 'tesseract' if ocr is not None else ('desligado' if not com_ocr else 'indisponivel')
    (destino / '_manifesto.json').write_text(json.dumps({
        'arquivo': pdf_path.name, 'paginas': total, 'motor': motor, 'ocr': ocr_do_run,
        'convertido_em': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'contagem': contagem, 'folhas': manifesto,
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    return destino, total, contagem


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
    ap.add_argument('--com-imagens', action='store_true',
                    help='também lê o texto dentro de figuras em folhas que já têm texto '
                         '(2,5x mais lento; medido sem ganho de conteúdo no caso de teste)')
    args = ap.parse_args()

    alvo = Path(args.alvo)
    if alvo.is_dir():
        autos = alvo / 'autos'
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

    if not pdfs:
        # Autos só em texto (.md/.txt) não são falha: o indexador lê esses arquivos direto, e não
        # há o que converter. Sair com 1 fazia o chefe tratar como erro uma pasta pronta (medido
        # em 24/09/2026, mandado de segurança). Pasta sem nada legível continua sendo erro.
        textos = listar_pdfs(autos, ('.md', '.txt')) if alvo.is_dir() else []
        if textos:
            sair(f'aviso: nenhum .pdf em autos/, só {len(textos)} arquivo(s) de texto (.md/.txt), '
                 'que o indexador lê direto. Nada a converter.', codigo=0)
        sair('nenhum .pdf em autos/: nada a converter')

    for pdf in pdfs:
        print(f'  convertendo {pdf.name}...', file=sys.stderr)
        destino, total, c = converter(pdf, saida, com_ocr=not args.sem_ocr, com_imagens=args.com_imagens,
                                      nome=nomes[pdf])
        print(f'autos-para-md: {pdf.name} → {destino}/documento.md '
              f'({total} folhas: {c["nativo"]} nativas, {c["ocr"]} OCR, {c["imagem"]} de imagem, '
              f'{c["vazia"]} sem texto)')


if __name__ == '__main__':
    main()
