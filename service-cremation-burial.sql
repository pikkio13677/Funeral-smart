-- Adds the combined cremation and burial service without changing existing providers or price lists.
INSERT INTO service_types (code, label, description, sort_order)
VALUES ('cremation-burial', 'Cremazione + Sepoltura', 'Servizi che combinano cremazione e successiva sepoltura', 25)
ON CONFLICT (code) DO NOTHING;
