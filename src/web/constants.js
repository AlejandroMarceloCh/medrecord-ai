export const FIELD_SECTIONS = [
  { key:'filiacion', icon:'user', title:'Filiación', cols:2, fields:[
    ['nombre','Nombre completo',false], ['documento','Documento / DNI',false],
    ['fecha_consulta','Fecha de consulta',false], ['fecha_nacimiento','Fecha de nacimiento',false],
    ['sexo','Sexo',false], ['ocupacion','Ocupación',false],
  ]},
  { key:'anamnesis', icon:'fileText', title:'Anamnesis', cols:1, fields:[
    ['motivo_consulta','Motivo de consulta',true], ['tiempo_enfermedad','Tiempo de enfermedad',false],
    ['sintomas','Síntomas referidos',true], ['antecedentes_personales','Antecedentes personales',true],
    ['antecedentes_familiares','Antecedentes familiares',true],
  ]},
  { key:'examen_fisico', icon:'activity', title:'Examen físico', cols:2, fields:[
    ['presion_arterial','Presión arterial',false], ['frecuencia_cardiaca','FC (lpm)',false],
    ['temperatura','Temperatura (°C)',false], ['peso_talla','Peso / Talla',false],
    ['saturacion','SpO₂ (%)',false], ['hallazgos','Hallazgos al examen',true],
  ]},
  { key:'impresion_diagnostica', icon:'clipboard', title:'Impresión diagnóstica', cols:1, fields:[
    ['diagnosticos','Diagnósticos',true], ['cie10','Código CIE-10',false],
  ]},
  { key:'plan', icon:'pill', title:'Plan / Indicaciones', cols:1, fields:[
    ['tratamiento','Tratamiento',true], ['examenes_solicitados','Exámenes solicitados',true],
    ['indicaciones','Indicaciones generales',true],
  ]},
];

export const REC_STATUS = {
  received:   { c:'var(--faint)',         t:'Recibido',           spin:true  },
  processing: { c:'var(--accent-strong)', t:'Transcribiendo…',    spin:true  },
  filling:    { c:'var(--accent-strong)', t:'Completando campos…', spin:true  },
  done:       { c:'var(--warn)',          t:'Por revisar',        spin:false },
  reviewed:   { c:'var(--ok)',            t:'Revisada',           spin:false },
  error:      { c:'var(--danger)',        t:'Error',              spin:false },
};

const CFG_KEY = 'medrecord.config';
export function loadConfig() {
  try { return { clinicName:'', doctorName:'', ...JSON.parse(localStorage.getItem(CFG_KEY)||'{}') }; }
  catch { return { clinicName:'', doctorName:'' }; }
}
export function saveConfig(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* noop */ }
}

const DICT_KEY = 'medrecord.dict';
export function loadDict()      { try { return JSON.parse(localStorage.getItem(DICT_KEY))||[]; } catch { return []; } }
export function saveDict(d)     { try { localStorage.setItem(DICT_KEY, JSON.stringify(d)); } catch { /* noop */ } }
