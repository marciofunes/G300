import { firstHourWithStatus } from './analytics';
import { MAINTENANCE_WINDOW, SPINDLE_EVENTS } from './generator';
import type { FieldEvent, InvestigationCase } from './types';

const case7Open = Math.max(0, firstHourWithStatus('G300-01', 'bomba-hidraulica', ['atencao', 'critico']));

export const BASE_EVENTS: FieldEvent[] = [
  {
    id: 'ev-001', machine: 'G300-01', asset: 'bomba-hidraulica', hour: MAINTENANCE_WINDOW[0], kind: 'intervencao',
    title: 'Manutenção corretiva no acumulador hidráulico',
    detail: 'Janelas do período marcadas como dirty e excluídas da referência (origem da correção v1.1 para v1.2).', source: 'base',
  },
  {
    id: 'ev-002', machine: 'G300-01', asset: 'spindle', hour: SPINDLE_EVENTS[1], kind: 'alerta',
    title: 'Pico de vibração no spindle em desbaste', detail: 'Evento curto (3 h), sem persistência.', source: 'base',
  },
  {
    id: 'ev-003', machine: 'G300-01', asset: 'spindle', hour: SPINDLE_EVENTS[3] + 2, kind: 'falha', caseId: '#0006',
    title: 'Batimento excessivo na ferramenta T12 (desbalanceamento)',
    detail: 'Confirmado pela manutenção. Ferramenta substituída e balanceamento do porta-ferramenta refeito.', source: 'base',
  },
  {
    id: 'ev-004', machine: 'G300-01', asset: 'bomba-hidraulica', hour: 540, kind: 'intervencao',
    title: 'Troca preventiva do filtro hidráulico', detail: 'Sem efeito sobre o nível de vibração.', source: 'base',
  },
  {
    id: 'ev-005', machine: 'G300-03', asset: 'eletrica', hour: 562, kind: 'dados', caseId: '#0005',
    title: 'Perda de comunicação do medidor elétrico', detail: 'Cabo de rede do medidor danificado; substituído.', source: 'base',
  },
  {
    id: 'ev-006', machine: 'G300-03', asset: 'bomba-alta-pressao', hour: 612, kind: 'dados', caseId: '#0008',
    title: 'Sensor VSE004 congelado (bomba alta pressão)', detail: 'Valor constante por 42 h; reiniciado o condicionador VSE100.', source: 'base',
  },
  {
    id: 'ev-007', machine: 'G300-01', asset: 'bomba-hidraulica', hour: case7Open, kind: 'alerta', caseId: '#0007',
    title: 'Alerta: desvio persistente', detail: 'Score acima do limiar de atenção com persistência mínima atingida.', source: 'base',
  },
  {
    id: 'ev-008', machine: 'G300-01', asset: 'bomba-hidraulica', hour: case7Open + 26, kind: 'inspecao', caseId: '#0007',
    title: 'Inspeção sensitiva: ruído anormal registrado', detail: 'Operador relata ruído metálico intermitente; temperatura do mancal levemente acima do usual.', source: 'base',
  },
  {
    id: 'ev-009', machine: 'G300-02', asset: 'bomba-refrigeracao', hour: 652, kind: 'inspecao',
    title: 'Inspeção: nível do tanque de refrigerante baixo', detail: 'Reabastecido; desvio curto se encerrou sem intervenção mecânica.', source: 'base',
  },
];

export const BASE_CASES: InvestigationCase[] = [
  {
    id: '#0007', machine: 'G300-01', asset: 'bomba-hidraulica', origin: 'Alerta automático', openedHour: case7Open, status: 'em-analise',
    title: 'Desvio persistente na bomba hidráulica',
    summary: 'RMS e curtose acima do envelope de referência em todos os regimes, com leve aumento de corrente. Tendência crescente nas últimas 3 semanas.',
    hypotheses: [
      { id: 'rolamento', label: 'Desgaste de rolamento do motor da bomba', support: 0.78,
        evidence: 'Curtose e fator de crista sobem junto com o RMS; corrente quase estável. Padrão típico de dano incipiente em pista.' },
      { id: 'cavitacao', label: 'Cavitação na sucção', support: 0.34,
        evidence: 'Aumento de RMS compatível, mas sem oscilação de corrente característica.',
        missing: 'Pressão de sucção não monitorada.' },
      { id: 'desalinhamento', label: 'Desalinhamento motor e bomba', support: 0.22,
        evidence: 'Não há aumento de potência proporcional; curtose alta é pouco típica.',
        missing: 'Análise espectral 1x/2x ainda não habilitada para bombas.' },
    ],
  },
  {
    id: '#0008', machine: 'G300-03', asset: 'bomba-alta-pressao', origin: 'Qualidade de dados', openedHour: 700, status: 'aberto',
    title: 'Sensor congelado novamente (bomba alta pressão)',
    summary: 'Segunda ocorrência de valor constante no VSE004. Janelas afetadas foram descartadas da análise; a condição do ativo não é avaliada enquanto durar.',
    hypotheses: [
      { id: 'conector', label: 'Conector M12 com mau contato', support: 0.6, evidence: 'Recorrência após reinício do condicionador.' },
      { id: 'condicionador', label: 'Falha no canal do VSE100', support: 0.3, evidence: 'Outros canais do mesmo condicionador seguem normais.' },
    ],
  },
  {
    id: '#0006', machine: 'G300-01', asset: 'spindle', origin: 'Alerta automático', openedHour: SPINDLE_EVENTS[2], closedHour: SPINDLE_EVENTS[3] + 2,
    status: 'encerrado', title: 'Eventos recorrentes de vibração no spindle',
    summary: 'Picos curtos de RMS em desbaste com curtose estável.',
    hypotheses: [{ id: 'desbalanceamento', label: 'Desbalanceamento da ferramenta', support: 0.85, evidence: 'Confirmado em campo.' }],
    result: { outcome: 'Falha confirmada', mode: 'Desbalanceamento da ferramenta', action: 'Ferramenta T12 substituída', note: 'Padrão incorporado à biblioteca.', hour: SPINDLE_EVENTS[3] + 2 },
  },
  {
    id: '#0005', machine: 'G300-03', asset: 'eletrica', origin: 'Qualidade de dados', openedHour: 562, closedHour: 578, status: 'encerrado',
    title: 'Gap de coleta elétrica', summary: 'Perda de dados do medidor trifásico por 16 h.',
    hypotheses: [{ id: 'cabo', label: 'Cabo de rede danificado', support: 0.9, evidence: 'Confirmado.' }],
    result: { outcome: 'Problema de dados', mode: 'Cabo de rede', action: 'Cabo substituído', note: '', hour: 578 },
  },
];

/** Patterns characterised from confirmed field outcomes (item 04, "Caracterizar padrões"). */
export const PATTERN_LIBRARY = [
  {
    id: 'pat-desbal', asset: 'Spindle', label: 'Desbalanceamento de ferramenta',
    signature: 'RMS +60 a 80 % em desbaste, curtose estável, eventos curtos (2 a 3 h) e recorrentes',
    confirmedBy: '#0006', confirmations: 1,
  },
  {
    id: 'pat-dados', asset: 'Qualquer', label: 'Falha de aquisição (gap / congelado)',
    signature: 'Completude < 95 % ou desvio padrão nulo na janela; não é condição do ativo',
    confirmedBy: '#0005', confirmations: 2,
  },
  {
    id: 'pat-rolamento', asset: 'Bombas', label: 'Dano incipiente em rolamento (candidato)',
    signature: 'RMS, curtose e crista crescendo juntos, corrente estável',
    confirmedBy: 'aguardando #0007', confirmations: 0,
  },
];
