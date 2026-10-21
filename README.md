# IPMAN · Gêmeo digital da linha de usinagem GROB G300

Frontend do gêmeo digital de 4 centros de usinagem GROB G300: operação ao vivo na visão geral e simulações *what-if* nas demais telas, com o resultado refletido nos indicadores e no modelo 3D.

## Subir

```bash
docker compose up -d --build      # http://localhost:8080
# ou, sem Docker
npm install && npm run dev        # http://localhost:5173
```

## Narrativa das telas

| Tela | O que mostra | What-if |
|---|---|---|
| **Visão geral** (ao vivo) | Telemetria a 1 amostra/s, consumo elétrico, peças, OEE e energia do dia, eventos em tempo real (ciclos, trocas, alertas), fila de atenção e valor gerado | Não se aplica: dados reais em tempo real |
| **Qualidade dos dados** | Estado da coleta e disponibilidade por sensor | Injeta falha de coleta (cabo desconectado, sensor congelado, ruído, saturação) e liga/desliga a qualificação automática. Mostra alarmes falsos, custo e falha mascarada; no 3D o LED do sensor muda e o ativo aparece como "sem dados" ou em falso alarme |
| **Comportamento normal** | Referência aprendida por regime (medido × faixa normal) | Muda rotação, avanço e pressão de refrigeração: tempo de ciclo, peças/h, kWh e custo por peça, margem até o limite ISO de vibração. A máquina 3D passa a operar no novo ponto. Também simula uma referência contaminada por janelas de manutenção e a antecedência perdida |
| **Condição dos ativos** | Saúde dos 4 ativos e contribuição de cada variável | Projeta a degradação (modo de falha e velocidade) e ajusta a política de alerta (limiar e persistência). Mostra data do alerta, falha provável, antecedência e alarmes falsos na frota; no 3D o ativo aparece como estará em +N dias |
| **Investigação e decisão** | Casos, linha do tempo, hipóteses, registro do resultado de campo e padrões aprendidos | Escolhe a data da intervenção e os custos: custo esperado por dia, risco de falha, economia contra operar até falhar e recomendação (aproveita a parada de domingo). Cria a ordem de manutenção; no 3D a máquina pode ser vista parada em manutenção |

O 3D tem câmeras rápidas (*Máquina*, *Área de trabalho*, *Bombas*) e **Raio-X**, que deixa toda a carcaça translúcida e mantém sólidos os componentes internos de interesse (spindle, mesa, berço, magazine, transportador e bombas).

## Performance

- **Um único palco WebGL** para o app inteiro: criado uma vez e reposicionado sobre a área 3D de cada tela. Trocar de tela não recria contexto, shaders nem texturas.
- Indicador de carregamento em duas etapas: inicialização da página e montagem do gêmeo (materiais, shaders), com shaders pré-compilados de forma assíncrona antes de exibir a cena.
- Modelo construído uma vez e clonado nas 4 máquinas (geometria e materiais compartilhados), materiais `MeshStandardMaterial`, aletas mescladas numa geometria por bomba, sombras estáticas, Raio-X sem recompilar shaders, resolução adaptativa sem oscilação e canvas com o mesmo tamanho em todas as telas.

Medido com Chromium sem GPU (renderização por software, então os números absolutos são piores que num navegador real): o bloqueio ao trocar de tela caiu de 1,4 a 5,7 s para 0 a 0,9 s.

## Dados

A operação é gerada de forma determinística: 30 dias de histórico por hora terminando na hora atual, mais telemetria por segundo sincronizada com o programa de usinagem que a máquina 3D executa. Cenários presentes: desgaste incipiente na bomba hidráulica da G300-01, desbalanceamento recorrente da ferramenta T12, sensor congelado e gap de comunicação na G300-03, G300-04 recém-comissionada com referência em aprendizado.

## Modelo 3D (img2threejs)

Gerado com o pipeline do [img2threejs](https://github.com/img2threejs/img2threejs) a partir da imagem de referência do G300 (`reference/`): análise da imagem, spec com componentes, pivôs e sockets dos sensores, materiais com evidência extraída da foto (`public/materials`) e comparações de cada passe (`reference/renders`). A factory gerada fica em `src/three/generated/`. Animação, sensores, condição e Raio-X ficam em `src/three/MachineTwin.ts`.

## Estrutura

```
src/data/        histórico, analítica, telemetria ao vivo (live.ts) e motores what-if (whatif.ts)
src/three/       factory gerada, MachineTwin, palco 3D persistente (TwinStage) e programa de usinagem
src/screens/     5 telas
src/components/  layout e componentes de UI
```
