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
- Página que não rende nem texto nem OCR sai como `vazia`, com o PNG ao lado —
  nunca se inventa conteúdo, e o agente pode abrir a imagem.
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
    base = unicodedata.normalize('NFD', Path(nome).stem)
    base = ''.join(c for c in base if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-zA-Z0-9]+', '-', base).strip('-').lower()[:80]


def carregar_deps(com_ocr):
    try:
        import pymupdf
    except ImportError:
        sair('PyMuPDF ausente — rode: pip install pymupdf4llm pytesseract Pillow')
    ocr = None
    if com_ocr:
        try:
            import pytesseract
            pytesseract.get_tesseract_version()
            ocr = pytesseract
        except Exception as e:                                   # noqa: BLE001
            print(f'  aviso: OCR indisponível ({e}) — páginas sem texto sairão como `vazia`',
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


def markdown_por_pagina(doc, pymupdf, total, bloco=BLOCO, com_imagens=False):
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
        print(f'  aviso: pymupdf4llm indisponível ({e}) — usando extração de texto simples',
              file=sys.stderr)
        return [doc.load_page(i).get_text() for i in range(total)], 'pymupdf-texto'

    textos, motor = [], 'pymupdf4llm'
    for inicio in range(0, total, bloco):
        fim = min(inicio + bloco, total)
        try:
            chunks = pymupdf4llm.to_markdown(doc, pages=list(range(inicio, fim)),
                                             page_chunks=True, show_progress=False,
                                             ignore_images=not com_imagens)
            textos += [c.get('text', '') for c in chunks]
        except Exception as e:                                   # noqa: BLE001
            # Bloco que falha não derruba o documento: cai para texto cru NESTE
            # trecho e segue. O manifesto continua dizendo a procedência folha a
            # folha, então a degradação é visível, não silenciosa.
            print(f'  aviso: folhas {inicio + 1}-{fim} falharam no pymupdf4llm ({e}) — texto simples',
                  file=sys.stderr)
            textos += [doc.load_page(i).get_text() for i in range(inicio, fim)]
            motor = 'pymupdf4llm+fallback'
        print(f'  extraídas {min(len(textos), total)}/{total} folhas...', file=sys.stderr, flush=True)
    return textos, motor


def converter(pdf_path, saida_dir, com_ocr=True, com_imagens=False):
    pymupdf, ocr = carregar_deps(com_ocr)
    nome = slug(pdf_path.name)
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
    sem_camada = {i for i in range(total) if len(doc.load_page(i).get_text().strip()) < MIN_TEXTO}
    print(f'  {total} folhas · {len(sem_camada)} sem camada de texto (irão a OCR)', file=sys.stderr)

    textos, motor = markdown_por_pagina(doc, pymupdf, total, com_imagens=com_imagens)
    if len(textos) < total:
        textos += [''] * (total - len(textos))

    blocos, manifesto = [], []
    for i in range(total):
        n = i + 1
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
            if len(texto) >= MIN_TEXTO:
                origem = 'ocr'
            elif ocr is not None:
                from PIL import Image
                try:
                    reconhecido = ocr.image_to_string(Image.open(png), lang=IDIOMA_OCR).strip()
                except Exception:                                # noqa: BLE001
                    reconhecido = ''
                texto, origem = (limpar(reconhecido), 'ocr') if len(reconhecido) >= MIN_TEXTO else ('', 'vazia')
            else:
                texto, origem = '', 'vazia'

        cabecalho = [f'<!-- fls. {n}/{total} · origem: {origem} -->', '', f'## fls. {n}', '']
        if origem == 'ocr':
            cabecalho += ['> **Texto reconhecido por OCR, não nativo do PDF.** Confira na imagem '
                          f'(`{imagem}`) antes de citar esta folha.', '']
        elif origem == 'vazia':
            cabecalho += ['> **Sem texto extraível.** Nada foi reconhecido nesta folha; a página '
                          f'está em `{imagem}` para leitura visual. Não há conteúdo a citar daqui.', '']
        blocos.append('\n'.join(cabecalho) + (texto + '\n' if texto else ''))
        manifesto.append({'pagina': n, 'origem': origem, 'caracteres': len(texto),
                          'imagem': imagem})
        if n % 100 == 0 or n == total:
            print(f'  montadas {n}/{total} folhas...', file=sys.stderr, flush=True)
    doc.close()

    contagem = {o: sum(1 for m in manifesto if m['origem'] == o) for o in ('nativo', 'ocr', 'vazia')}
    topo = [
        f'# {pdf_path.name}',
        '',
        f'> Convertido de PDF em {datetime.now(timezone.utc).isoformat(timespec="seconds")} '
        f'por `autos-para-md.py` ({motor}).',
        f'> {total} folhas — {contagem["nativo"]} com texto nativo, {contagem["ocr"]} por OCR, '
        f'{contagem["vazia"]} sem texto extraível.',
        '> Cada folha abre com `## fls. N`. **Cite a folha, nunca de memória**; o que veio de OCR '
        'está marcado folha a folha e exige conferência na imagem.',
        '',
    ]
    (destino / 'documento.md').write_text('\n'.join(topo) + '\n'.join(blocos), encoding='utf-8')
    (destino / '_manifesto.json').write_text(json.dumps({
        'arquivo': pdf_path.name, 'paginas': total, 'motor': motor,
        'convertido_em': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'contagem': contagem, 'folhas': manifesto,
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    return destino, total, contagem


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
        if not autos.is_dir():
            sair(f'sem pasta autos/ em {alvo} — nada a converter')
        pdfs = sorted(autos.glob('*.pdf'))
        saida = Path(args.saida) if args.saida else autos / '_md'
    elif alvo.suffix.lower() == '.pdf' and alvo.is_file():
        pdfs, saida = [alvo], Path(args.saida) if args.saida else alvo.parent / '_md'
    else:
        sair(f'{alvo} não é pasta de squad nem arquivo .pdf')

    if not pdfs:
        sair('nenhum .pdf em autos/ — nada a converter')

    for pdf in pdfs:
        print(f'  convertendo {pdf.name}...', file=sys.stderr)
        destino, total, c = converter(pdf, saida, com_ocr=not args.sem_ocr, com_imagens=args.com_imagens)
        print(f'autos-para-md: {pdf.name} → {destino}/documento.md '
              f'({total} folhas: {c["nativo"]} nativas, {c["ocr"]} OCR, {c["vazia"]} sem texto)')


if __name__ == '__main__':
    main()
